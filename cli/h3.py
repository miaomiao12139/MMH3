#!/usr/bin/env python3
"""H3 local automation client. Python standard library only."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path(os.environ.get('LOCALAPPDATA', Path.home() / '.config')) / 'H3CLI' / 'config.json'

def read_json(value):
    if value.startswith('@'):
        return json.loads(Path(value[1:]).read_text(encoding='utf-8-sig'))
    return json.loads(value)

def root_path(explicit=None):
    if explicit or os.environ.get('H3_APP_ROOT'):
        return Path(explicit or os.environ['H3_APP_ROOT']).expanduser().resolve()
    if CONFIG.exists():
        return Path(json.loads(CONFIG.read_text(encoding='utf-8-sig'))['appRoot'])
    raise ValueError('请先执行 h3 auth login --app-root "H3的App目录"，并打开 H3 软件')

class Client:
    def __init__(self, root):
        self.root = root

    def request(self, method, route, body=None, key=None):
        if not route.startswith('/api/v1/') or '?' in route or '#' in route or '..' in route:
            raise ValueError('接口路径必须位于 /api/v1/')
        descriptor = json.loads((self.root / 'user' / 'studio-api.json').read_text(encoding='utf-8-sig'))
        base = descriptor['baseUrl']
        url = urllib.parse.urlsplit(base)
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('拒绝向非本机地址发送 H3 凭据')
        headers = {'Authorization': 'Bearer ' + descriptor['token'], 'Content-Type': 'application/json'}
        if key:
            headers['Idempotency-Key'] = key
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(base.rstrip('/') + route, data=data, headers=headers, method=method)
        # Local requests must never follow redirects or use a system proxy.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as e:
            try:
                message = json.load(e).get('error', 'HTTP ' + str(e.code))
            except (ValueError, AttributeError):
                message = 'HTTP ' + str(e.code)
            raise ValueError(message) from None
        if result.get('ok') is False:
            raise ValueError(result.get('error', 'H3 操作失败'))
        return result

    def job(self, job_id, cancel=False):
        group = 'tasks' if job_id.startswith('api-') else 'jobs'
        route = '/api/v1/' + group + '/' + urllib.parse.quote(job_id, safe='')
        return self.request('POST' if cancel else 'GET', route + ('/cancel' if cancel else ''))

    def wait(self, job_id, timeout):
        deadline = time.monotonic() + timeout
        while True:
            result = self.job(job_id)
            state = result['job']['state']
            if state in ('completed', 'failed', 'cancelled', 'interrupted'):
                result['ok'] = state == 'completed'
                return result
            if time.monotonic() >= deadline:
                return {'ok': False, 'error': '等待超时；任务仍可能运行，请按 id 查询，勿重复提交', 'job': result['job']}
            time.sleep(min(1, max(0, deadline - time.monotonic())))

def parser():
    p = argparse.ArgumentParser(description='H3 本地 CLI：图片、视频、语音和任务管理；JSON 输出')
    p.add_argument('--app-root', help='H3 App 目录，也可使用 H3_APP_ROOT')
    sub = p.add_subparsers(dest='command', required=True)
    auth = sub.add_parser('auth').add_subparsers(dest='auth_command', required=True)
    login = auth.add_parser('login', help='连接本机 H3，无需云账号')
    login.add_argument('--app-root', dest='login_root', required=True)
    auth.add_parser('status')
    for command in ('doctor', 'capabilities', 'outputs', 'queue', 'openapi'):
        sub.add_parser(command)
    for command in ('generate', 'task'):
        cmd = sub.add_parser(command, help='JSON 参数支持 @UTF8文件')
        if command == 'task':
            cmd.add_argument('kind', choices=['enhance', 'image-enhance', 'interpolate', 'understand', 'segment', 'voice', 'cutout-batch'])
        cmd.add_argument('--input', required=True, help='JSON 对象或 @文件；generate 为视频参数，task 为工具输入')
        cmd.add_argument('--wait', action='store_true')
        cmd.add_argument('--timeout', type=float, default=3600)
        if command == 'task':
            cmd.add_argument('--request-key', help='重试去重键；同一键必须使用相同参数')
    jobs = sub.add_parser('jobs').add_subparsers(dest='jobs_command', required=True)
    jobs.add_parser('list')
    for command in ('get', 'cancel', 'wait'):
        cmd = jobs.add_parser(command)
        cmd.add_argument('id')
        if command == 'wait':
            cmd.add_argument('--timeout', type=float, default=3600)
    action = sub.add_parser('action', help='管理功能，名称由 capabilities 查询')
    action.add_argument('name')
    action.add_argument('--args', default='[]', help='JSON 参数数组或 @文件')
    action.add_argument('--confirm', action='store_true', help='确认删除、清空或恢复操作')
    api = sub.add_parser('api', help='直接调用本机接口')
    api.add_argument('method', choices=['GET', 'POST'])
    api.add_argument('path')
    api.add_argument('--body', help='JSON 或 @文件')
    skill = sub.add_parser('skill').add_subparsers(dest='skill_command', required=True)
    skill.add_parser('show')
    install = skill.add_parser('install')
    install.add_argument('--target', choices=['codex', 'claude'], default='codex')
    return p

def run(a):
    if a.command == 'skill':
        source = Path(__file__).resolve().parent / 'skills' / 'h3-studio'
        if a.skill_command == 'show':
            return {'ok': True, 'path': str(source / 'SKILL.md'), 'content': (source / 'SKILL.md').read_text(encoding='utf-8')}
        base = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) if a.target == 'codex' else Path.home() / '.claude'
        target = base / 'skills' / 'h3-studio'
        shutil.copytree(source, target, dirs_exist_ok=True)
        return {'ok': True, 'skill': str(target / 'SKILL.md')}
    root = root_path(a.login_root if a.command == 'auth' and a.auth_command == 'login' else a.app_root)
    client = Client(root)
    if a.command == 'auth':
        health = client.request('GET', '/api/v1/health')
        if a.auth_command == 'login':
            client.request('GET', '/api/v1/capabilities')
            CONFIG.parent.mkdir(parents=True, exist_ok=True)
            CONFIG.write_text(json.dumps({'appRoot': str(root)}, ensure_ascii=False, indent=2), encoding='utf-8')
        return {'ok': True, 'appRoot': str(root), 'auth': '本机连接，无需云端登录', 'health': health}
    if a.command == 'doctor':
        health = client.request('GET', '/api/v1/health')
        capabilities = client.request('GET', '/api/v1/capabilities')
        return {'ok': True, 'appRoot': str(root), 'health': health, 'tools': capabilities['tools'], 'engineReady': health['engineReady']}
    if a.command in ('capabilities', 'outputs', 'queue', 'openapi'):
        return client.request('GET', '/api/v1/' + ('openapi.json' if a.command == 'openapi' else a.command))
    if a.command in ('generate', 'task'):
        body = read_json(a.input)
        if not isinstance(body, dict):
            raise ValueError('input 必须是 JSON 对象')
        result = client.request('POST', '/api/v1/tasks' if a.command == 'task' else '/api/v1/generate', {'kind': a.kind, 'input': body} if a.command == 'task' else body, getattr(a, 'request_key', None))
        if a.wait:
            job_id = (result.get('job') or {}).get('id') or result.get('jobId')
            if not job_id:
                raise ValueError('服务未返回任务 id，请查询 jobs list，勿重复提交')
            return client.wait(job_id, a.timeout)
        return result
    if a.command == 'jobs':
        if a.jobs_command == 'list':
            return {'ok': True, 'tools': client.request('GET', '/api/v1/tasks')['jobs'], 'video': client.request('GET', '/api/v1/queue')['jobs']}
        return client.wait(a.id, a.timeout) if a.jobs_command == 'wait' else client.job(a.id, a.jobs_command == 'cancel')
    if a.command == 'action':
        args = read_json(a.args)
        if not isinstance(args, list):
            raise ValueError('args 必须是 JSON 数组')
        return client.request('POST', '/api/v1/actions', {'action': a.name, 'args': args, 'confirm': a.confirm})
    if a.command == 'api':
        return client.request(a.method, a.path, read_json(a.body) if a.body else None)

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    try:
        result = run(parser().parse_args())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get('ok', True) else 1
    except (OSError, ValueError, KeyError, urllib.error.URLError) as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
