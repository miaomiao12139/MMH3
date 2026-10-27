#!/usr/bin/env python3
"""H3 local automation client. Python standard library only."""
import argparse
import http.client
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path(os.environ.get('LOCALAPPDATA', Path.home() / '.config')) / 'H3CLI' / 'config.json'
CLI_VERSION = '1.1.19'

class UsageError(ValueError):
    pass

class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(message)

def duration(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('timeout 必须是大于 0 的有限秒数')
    return number

def load_object(file, label):
    try:
        value = json.loads(file.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        raise ValueError(label + '不存在，请打开 H3 并执行 h3 auth login --app-root "App目录"') from None
    except (ValueError, UnicodeError):
        raise ValueError(label + '不是有效的 UTF-8 JSON，请修复该文件后重试') from None
    if not isinstance(value, dict):
        raise ValueError(label + '必须是 JSON 对象')
    return value

def save_config(root):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='config-', suffix='.tmp', dir=CONFIG.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            json.dump({'appRoot': str(root)}, file, ensure_ascii=False, indent=2)
        os.replace(name, CONFIG)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def read_json(value):
    if value == '-':
        return json.load(sys.stdin)
    if value.startswith('@'):
        return json.loads(Path(value[1:]).read_text(encoding='utf-8-sig'))
    return json.loads(value)

def root_path(explicit=None):
    if explicit or os.environ.get('H3_APP_ROOT'):
        return Path(explicit or os.environ['H3_APP_ROOT']).expanduser().resolve()
    if CONFIG.exists():
        value = load_object(CONFIG, 'CLI 配置').get('appRoot')
        if not isinstance(value, str) or not value.strip():
            raise ValueError('CLI 配置缺少有效的 appRoot，请重新执行 h3 auth login --app-root "App目录"')
        return Path(value).expanduser().resolve()
    raise ValueError('请先执行 h3 auth login --app-root "H3的App目录"，并打开 H3 软件')

class Client:
    def __init__(self, root):
        self.root = root

    def request(self, method, route, body=None, key=None, timeout=30):
        if not route.startswith('/api/v1/') or '?' in route or '#' in route or '..' in route:
            raise ValueError('接口路径必须位于 /api/v1/')
        descriptor = load_object(self.root / 'user' / 'studio-api.json', 'H3 连接描述文件')
        base = descriptor.get('baseUrl')
        token = descriptor.get('token')
        if not isinstance(base, str) or not isinstance(token, str) or not token or any(c in token for c in '\r\n'):
            raise ValueError('H3 连接描述文件缺少有效的 baseUrl 或 token，请重启 H3')
        url = urllib.parse.urlsplit(base)
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('拒绝向非本机地址发送 H3 凭据')
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if key:
            if not isinstance(key, str) or len(key) > 128 or any(ord(c) < 33 or ord(c) > 126 for c in key):
                raise ValueError('request-key 必须是最多 128 字符的可打印 ASCII 字符串，不能含空白')
            headers['Idempotency-Key'] = key
        data = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
        request = urllib.request.Request(base.rstrip('/') + route, data=data, headers=headers, method=method)
        # Local requests must never follow redirects or use a system proxy.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as e:
            try:
                message = json.load(e).get('error', 'HTTP ' + str(e.code))
            except (ValueError, AttributeError):
                message = 'HTTP ' + str(e.code)
            raise ValueError(message) from None
        if not isinstance(result, dict):
            raise ValueError('H3 返回的响应必须是 JSON 对象')
        if result.get('ok') is False:
            raise ValueError(result.get('error', 'H3 操作失败'))
        return result

    def job(self, job_id, cancel=False, timeout=30):
        group = 'tasks' if job_id.startswith('api-') else 'jobs'
        route = '/api/v1/' + group + '/' + urllib.parse.quote(job_id, safe='')
        return self.request('POST' if cancel else 'GET', route + ('/cancel' if cancel else ''), timeout=timeout)

    def wait(self, job_id, timeout):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError('timeout 必须是大于 0 的有限秒数')
        deadline = time.monotonic() + timeout
        last_job = {'id': job_id}
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {'ok': False, 'error': '等待超时；任务仍可能运行，请按 id 查询，勿重复提交', 'job': last_job}
            try:
                result = self.job(job_id, timeout=min(30, remaining))
            except KeyboardInterrupt:
                return {'ok': False, 'error': '已停止等待；远端任务未取消，请按 id 查询或执行 jobs cancel', 'job': last_job}
            except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException) as e:
                return {'ok': False, 'error': '等待中断：' + str(e) + '；请按任务 id 查询，勿重复提交', 'job': last_job}
            job = result.get('job')
            if not isinstance(job, dict) or not isinstance(job.get('state'), str):
                return {'ok': False, 'error': '任务响应缺少有效状态，请按 id 查询', 'job': last_job}
            last_job = job
            state = job['state']
            if state in ('completed', 'failed', 'cancelled', 'interrupted'):
                result['ok'] = state == 'completed' and not job.get('persistenceError')
                if not result['ok']:
                    result['error'] = job.get('persistenceError') or job.get('error') or '任务状态：' + state
                return result
            if time.monotonic() >= deadline:
                return {'ok': False, 'error': '等待超时；任务仍可能运行，请按 id 查询，勿重复提交', 'job': last_job}
            time.sleep(min(1, max(0, deadline - time.monotonic())))

def parser():
    p = ArgumentParser(description='H3 本地 CLI：图片、视频、语音和任务管理；JSON 输出')
    p.add_argument('--version', action='version', version=CLI_VERSION)
    p.add_argument('--app-root', help='H3 App 目录，也可使用 H3_APP_ROOT')
    sub = p.add_subparsers(dest='command', required=True)
    auth = sub.add_parser('auth').add_subparsers(dest='auth_command', required=True)
    login = auth.add_parser('login', help='连接本机 H3，无需云账号')
    login.add_argument('--app-root', dest='app_root', default=argparse.SUPPRESS)
    auth.add_parser('status')
    for command in ('doctor', 'capabilities', 'outputs', 'queue', 'openapi'):
        sub.add_parser(command)
    for command in ('generate', 'task'):
        cmd = sub.add_parser(command, help='JSON 参数支持 @UTF8文件')
        if command == 'task':
            cmd.add_argument('kind', choices=['enhance', 'image-enhance', 'interpolate', 'understand', 'segment', 'voice', 'cutout-batch'])
        cmd.add_argument('--input', required=True, help='JSON 对象、@UTF8文件或 -（标准输入）')
        cmd.add_argument('--wait', action='store_true')
        cmd.add_argument('--timeout', type=duration, default=3600)
        if command == 'task':
            cmd.add_argument('--request-key', help='重试去重键；同一键必须使用相同参数')
    jobs = sub.add_parser('jobs').add_subparsers(dest='jobs_command', required=True)
    jobs.add_parser('list')
    for command in ('get', 'cancel', 'wait'):
        cmd = jobs.add_parser(command)
        cmd.add_argument('id')
        if command == 'wait':
            cmd.add_argument('--timeout', type=duration, default=3600)
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
    def add_root_options(node):
        if node is not p and '--app-root' not in node._option_string_actions:
            node.add_argument('--app-root', default=argparse.SUPPRESS, help='H3 App 目录')
        for action in node._actions:
            if isinstance(action, argparse._SubParsersAction):
                for child in action.choices.values():
                    add_root_options(child)
    add_root_options(p)
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
    root = root_path(a.app_root)
    client = Client(root)
    if a.command == 'auth':
        health = client.request('GET', '/api/v1/health')
        if a.auth_command == 'login':
            client.request('GET', '/api/v1/capabilities')
            save_config(root)
        return {'ok': True, 'appRoot': str(root), 'auth': '本机连接，无需云端登录', 'health': health}
    if a.command == 'doctor':
        health = client.request('GET', '/api/v1/health')
        capabilities = client.request('GET', '/api/v1/capabilities')
        ready = health.get('engineReady') is True
        return {'ok': ready, 'appRoot': str(root), 'health': health, 'tools': capabilities.get('tools', []), 'engineReady': ready, **({} if ready else {'error': 'H3 已连接，但本地引擎尚未就绪，请等待启动或检查引擎自检'})}
    if a.command in ('capabilities', 'outputs', 'queue', 'openapi'):
        return client.request('GET', '/api/v1/' + ('openapi.json' if a.command == 'openapi' else a.command))
    if a.command in ('generate', 'task'):
        body = read_json(a.input)
        if not isinstance(body, dict):
            raise ValueError('input 必须是 JSON 对象')
        try:
            result = client.request('POST', '/api/v1/tasks' if a.command == 'task' else '/api/v1/generate', {'kind': a.kind, 'input': body} if a.command == 'task' else body, getattr(a, 'request_key', None))
        except (OSError, urllib.error.URLError, http.client.HTTPException) as e:
            return {'ok': False, 'error': str(e), 'submissionUnknown': True, 'requestKey': getattr(a, 'request_key', None), 'hint': '提交连接中断，任务可能已接收。先查询 h3 jobs list；工具任务可用相同 request-key 和相同参数重试，勿直接重复提交。'}
        if a.wait:
            job = result.get('job')
            job_id = (job.get('id') if isinstance(job, dict) else None) or result.get('jobId')
            if not isinstance(job_id, str) or not job_id:
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
    except (OSError, ValueError, KeyError, urllib.error.URLError, http.client.HTTPException) as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False), file=sys.stderr)
        return 2 if isinstance(e, UsageError) else 1
    except KeyboardInterrupt:
        print(json.dumps({'ok': False, 'error': '操作已中断；已提交的任务可能仍在运行，请查询 jobs list'}, ensure_ascii=False), file=sys.stderr)
        return 130

if __name__ == '__main__':
    sys.exit(main())
