import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest

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

if __name__=='__main__': unittest.main()
