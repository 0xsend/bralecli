"""Offline release checks. All credentials and tokens below are synthetic fixtures."""
import json, os, subprocess, sys, tempfile, threading, selectors
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

binary = str(Path(sys.argv[1]).resolve())
requests = []
class Mock(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        requests.append((self.command, self.path, dict(self.headers), body))
        self.respond({'access_token':'fixture-token','token_type':'Bearer','expires_in':3600} if self.path == '/oauth2/token' else {'id':'fixture-transfer'})
    def do_GET(self):
        requests.append((self.command, self.path, dict(self.headers), b''))
        self.respond({'data':[{'id':'fixture-account'}]})
    def respond(self, data):
        body=json.dumps(data).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)

with tempfile.TemporaryDirectory(prefix='bralecli-smoke-') as cwd:
    env={'PATH':'/nonexistent','HOME':cwd,'NO_COLOR':'1'}
    def run(*args, extra=None, success=True):
        result=subprocess.run([binary,*args],cwd=cwd,env={**env,**(extra or {})},text=True,capture_output=True,timeout=20)
        if success: assert result.returncode == 0, (args,result.returncode,result.stdout,result.stderr)
        else: assert result.returncode != 0, args
        return result.stdout
    assert run('--version').strip() == sys.argv[2]
    assert 'list_accounts' in run('--help')
    assert 'Usage: bralecli create_transfer' in run('create_transfer','--help')
    assert 'bralecli list_accounts' in run('--llms')
    assert 'page_size' in run('list_accounts','--schema')
    for command in ['completions','mcp','skills']:
        assert f'Usage: bralecli {command}' in run(command,'--help')
    assert 'bralecli' in run('completions','bash')
    # If automatic .env loading regresses, this produces an invalid-whitespace
    # credential error rather than the expected missing-credentials error.
    Path(cwd,'.env').write_text('BRALE_CLIENT_ID="fixture id"\nBRALE_CLIENT_SECRET=fixture-secret\n')
    assert 'no Brale OAuth credentials' in run('list_accounts',success=False)
    server=ThreadingHTTPServer(('127.0.0.1',0),Mock)
    thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    base=f'http://127.0.0.1:{server.server_port}'
    config={'BRALE_CLIENT_ID':'fixture-id','BRALE_CLIENT_SECRET':'fixture-secret','BRALE_API_BASE_URL':base,'BRALE_AUTH_BASE_URL':base}
    try:
        assert 'fixture-account' in run('list_accounts','--page_size','2',extra=config)
        api=[r for r in requests if r[1] != '/oauth2/token'][-1]
        assert parse_qs(urlparse(api[1]).query) == {'page[size]':['2']}, api[1]
        assert {k.lower():v for k,v in api[2].items()}.get('authorization') == 'Bearer fixture-token', api[2]
        args=['create_transfer','2VZvtmVc2j3gQ80CTlcuQXbGrwC','--amount','{"value":"10","currency":"USD"}','--source','{"value_type":"USD","transfer_type":"wire"}','--destination','{"value_type":"CUSD","transfer_type":"base","address_id":"2VZvtmVc2j3gQ80CTlcuQXbGrwC"}']
        assert 'fixture-transfer' in run(*args,extra=config)
        transfer=[r for r in requests if r[1].endswith('/transfers')][-1]
        body=json.loads(transfer[3]); assert isinstance(body['source'],dict) and body['destination']['value_type']=='CUSD'
        count=len(requests)
        run('get_account','../other',extra=config,success=False)
        assert len(requests)==count, 'Invalid ID reached network'
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)
    messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'release-smoke','version':'1'}}},{'jsonrpc':'2.0','method':'notifications/initialized'},{'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}}]
    process=subprocess.Popen([binary,'--mcp'],cwd=cwd,env=env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    selector=selectors.DefaultSelector(); selector.register(process.stdout,selectors.EVENT_READ)
    def send(message):
        process.stdin.write(json.dumps(message)+'\n'); process.stdin.flush()
    def receive(identifier):
        for _ in range(100):
            assert selector.select(20), 'MCP response timed out'
            line=process.stdout.readline()
            assert line, 'MCP server closed before response'
            response=json.loads(line)
            if response.get('id')==identifier: return response
        raise AssertionError('Too many MCP notifications')
    try:
        send(messages[0]); assert 'result' in receive(1)
        send(messages[1]); send(messages[2])
        listing=receive(2)
        assert any(t['name']=='search_tools' for t in listing['result']['tools']), listing
        send({'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'search_tools','arguments':{'query':'list_accounts'}}})
        found=receive(3)
        assert not found.get('error') and not found.get('result',{}).get('isError'), found
        assert 'list_accounts' in json.dumps(found), found
        send({'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'get_tool_details','arguments':{'name':'create_transfer'}}})
        details=receive(4)
        assert not details.get('error') and not details.get('result',{}).get('isError'), details
        assert 'amount' in json.dumps(details), details
    finally:
        selector.close(); process.terminate(); process.wait(timeout=5)

print(Path(binary).name+': PASS (standalone, env isolation, help/schema, integrations, mock OAuth/list/transfer, input safety, MCP tool discovery)')
