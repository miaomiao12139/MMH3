import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from unittest.mock import patch
import subprocess
import sys
import http.client
import io

spec = importlib.util.spec_from_file_location('h3', Path(__file__).resolve().parents[1] / 'cli' / 'h3.py')
h3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h3)

class Handler(BaseHTTPRequestHandler):
    received = []
    def log_message(self, *args): pass
    def do_GET(self):
        self.received.append((self.path, self.headers.get('Authorization')))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'ok':True,'job':{'id':'api-test','state':'completed','result':{'text':'中文'}}}).encode())
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        self.received.append((self.path,data,self.headers.get('Idempotency-Key')))
        self.send_response(202)
        self.end_headers()
        self.wfile.write(json.dumps({'ok':True,'job':{'id':'api-test','state':'running'}}).encode())

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=HTTPServer(('127.0.0.1',0),Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='H3 中文 paths ')
        self.root=Path(self.temp.name)
        (self.root/'user').mkdir()
        self.descriptor=self.root/'user'/'studio-api.json'
        self.descriptor.write_text(json.dumps({'baseUrl':'http://127.0.0.1:'+str(self.server.server_port),'token':'test-only'}),encoding='utf-8')
        self.client=h3.Client(self.root)
    def tearDown(self): self.temp.cleanup()
    def test_bearer_and_poll(self):
        self.assertTrue(self.client.wait('api-test',2)['ok'])
        self.assertEqual(Handler.received[-1],('/api/v1/tasks/api-test','Bearer test-only'))
    def test_unicode_and_idempotency(self):
        value={'kind':'voice','input':{'text':'你好'}}
        self.client.request('POST','/api/v1/tasks',value,'unique')
        self.assertEqual(Handler.received[-1],('/api/v1/tasks',value,'unique'))
    def test_refuse_credential_exfiltration(self):
        for base in ['https://example.com','http://localhost:18480','http://127.0.0.1:1234@evil.test:80','http://127.0.0.1:1234/path']:
            self.descriptor.write_text(json.dumps({'baseUrl':base,'token':'test-only'}))
            with self.assertRaises(ValueError): self.client.request('GET','/api/v1/health')
    def test_fresh_descriptor(self):
        self.descriptor.write_text(json.dumps({'baseUrl':'http://127.0.0.1:'+str(self.server.server_port),'token':'rotated'}))
        self.client.job('video-test')
        self.assertEqual(Handler.received[-1],('/api/v1/jobs/video-test','Bearer rotated'))
    def test_utf8_bom_file(self):
        file=self.root/'参数.json'
        file.write_text('{"text":"你好"}',encoding='utf-8-sig')
        self.assertEqual(h3.read_json('@'+str(file)),{'text':'你好'})
    def test_path_boundary(self):
        for route in ['https://example.com','/other','/api/v1/../token','/api/v1/health?token=a']:
            with self.assertRaises(ValueError): self.client.request('GET',route)

    def test_root_option_at_every_level(self):
        for argv in [ ['--app-root','中文','jobs','list'], ['jobs','--app-root','中文','list'], ['jobs','list','--app-root','中文'], ['--app-root','中文','auth','login'] ]:
            self.assertEqual(h3.parser().parse_args(argv).app_root, '中文')

    def test_argument_errors_are_json(self):
        for argv in [[], ['wat'], ['task','voice','--input','{}','--timeout','nan'], ['jobs','wait','api-x','--timeout','inf'], ['generate','--input','{}','--timeout','-1']]:
            result=subprocess.run([sys.executable,str(Path(h3.__file__)),*argv],capture_output=True,encoding='utf-8')
            self.assertEqual(result.returncode,2, result.stderr)
            self.assertFalse(json.loads(result.stderr)['ok'])
            self.assertNotIn('Traceback',result.stderr)

    def test_bad_descriptor(self):
        for value in [None, [], {'baseUrl':42,'token':'secret'}, {'baseUrl':'http://127.0.0.1:12','token':[]}]:
            self.descriptor.write_text(json.dumps(value),encoding='utf-8')
            with self.assertRaises(ValueError): self.client.job('api-x')

    def test_bad_config(self):
        file=self.root/'config.json'
        with patch.object(h3,'CONFIG',file), patch.dict(h3.os.environ,{'H3_APP_ROOT':''}):
            for value in [None, [], {}, {'appRoot':23}]:
                file.write_text(json.dumps(value),encoding='utf-8')
                with self.assertRaises(ValueError): h3.root_path()

    def test_wait_preserves_identity_and_deadline(self):
        with patch.object(self.client,'job',side_effect=http.client.RemoteDisconnected('closed')) as poll:
            result=self.client.wait('api-known',0.1)
        self.assertFalse(result['ok'])
        self.assertEqual(result['job']['id'],'api-known')
        self.assertLessEqual(poll.call_args.kwargs['timeout'],0.1)

    def test_terminal_failures(self):
        for job in [{'state':'failed','error':'bad'}, {'state':'cancelled'}, {'state':'completed','persistenceError':'disk full'}]:
            with patch.object(self.client,'job',return_value={'ok':True,'job':job}):
                result=self.client.wait('api-known',1)
            self.assertFalse(result['ok'])
            self.assertTrue(result['error'])

    def test_interrupt_wait_keeps_remote_job(self):
        with patch.object(self.client,'job',side_effect=KeyboardInterrupt) as poll:
            result=self.client.wait('api-known',1)
        self.assertFalse(result['ok'])
        self.assertEqual(result['job']['id'],'api-known')
        self.assertEqual(poll.call_count,1)

    def test_malformed_job(self):
        for job in [None, [], 'oops', {}]:
            with patch.object(self.client,'job',return_value={'job':job}):
                self.assertFalse(self.client.wait('api-known',1)['ok'])
            args=h3.parser().parse_args(['task','voice','--input','{}','--wait','--app-root',str(self.root)])
            with patch.object(h3.Client,'request',return_value={'ok':True,'job':job}):
                with self.assertRaises(ValueError): h3.run(args)

    def test_doctor_detects_unready_engine(self):
        args=h3.parser().parse_args(['doctor','--app-root',str(self.root)])
        with patch.object(h3.Client,'request',side_effect=[{'ok':True,'engineReady':False},{'tools':[]}]):
            self.assertFalse(h3.run(args)['ok'])

    def test_submission_uncertainty_no_retry(self):
        args=h3.parser().parse_args(['task','voice','--input','{}','--app-root',str(self.root)])
        with patch.object(h3.Client,'request',side_effect=http.client.RemoteDisconnected('closed')) as send:
            result=h3.run(args)
        self.assertTrue(result['submissionUnknown'])
        self.assertEqual(send.call_count,1)

    def test_stdin_unicode(self):
        with patch.object(h3.sys,'stdin',io.StringIO('{"text":"你好"}')):
            self.assertEqual(h3.read_json('-'),{'text':'你好'})

    def test_request_key_and_nonfinite_body(self):
        for key in ['bad key','a\r\nb','中文','x'*129]:
            with self.assertRaises(ValueError): self.client.request('POST','/api/v1/tasks',{},key)
        with self.assertRaises(ValueError): self.client.request('POST','/api/v1/tasks',{'x':float('nan')})

if __name__=='__main__': unittest.main()
