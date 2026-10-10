#!/usr/bin/env python3
"""Command bridge for a macOS guest that has no ssh yet (recovery / first boot).

Runs inside the dockur container. The guest polls GET /next for a command, runs it and POSTs the
output to /result. The host drives it with `docker exec <ctr> python3 bridge.py run '<cmd>'`.
Only reachable from the guest (container-internal port, never published).
"""
import http.server, json, os, re, sys, time, urllib.request

PORT = int(os.environ.get("OSMATRIX_BRIDGE_PORT", "8099"))
DIR = "/tmp/osmatrix-bridge"


FILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def safe_file(name):
    """Resolve a /file/<name> request to a regular file directly inside DIR/files, or None."""
    if not FILE_NAME.fullmatch(name):
        return None
    root = os.path.realpath(os.path.join(DIR, "files"))
    path = os.path.realpath(os.path.join(root, name))
    if os.path.dirname(path) != root or not os.path.isfile(path):
        return None
    return path


def serve():
    os.makedirs(DIR, exist_ok=True)

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b""):
            self.send_response(code)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            open(os.path.join(DIR, "seen"), "w").write(str(time.time()))
            if self.path == "/next":
                q = os.path.join(DIR, "cmd")
                if os.path.exists(q) and not os.path.exists(os.path.join(DIR, "taken")):
                    open(os.path.join(DIR, "taken"), "w").write("1")
                    return self._send(200, open(q, "rb").read())
                return self._send(204)
            if self.path.startswith("/file/"):
                f = safe_file(self.path[len("/file/"):])
                if f:
                    with open(f, "rb") as fh:
                        return self._send(200, fh.read())
            self._send(404)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            if self.path == "/result":
                open(os.path.join(DIR, "result.tmp"), "wb").write(body)
                os.replace(os.path.join(DIR, "result.tmp"), os.path.join(DIR, "result"))
                return self._send(200)
            if self.path == "/log":
                with open(os.path.join(DIR, "log"), "ab") as f:
                    f.write(body)
                return self._send(200)
            self._send(404)

    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()


def run(cmd, timeout):
    for f in ("result", "taken"):
        try:
            os.remove(os.path.join(DIR, f))
        except FileNotFoundError:
            pass
    tmp = os.path.join(DIR, "cmd.tmp")
    open(tmp, "w").write(cmd)
    os.replace(tmp, os.path.join(DIR, "cmd"))
    deadline = time.time() + timeout
    res = os.path.join(DIR, "result")
    while time.time() < deadline:
        if os.path.exists(res):
            os.remove(os.path.join(DIR, "cmd"))
            sys.stdout.write(open(res).read())
            return 0
        time.sleep(0.5)
    os.remove(os.path.join(DIR, "cmd"))
    sys.stderr.write("timeout waiting for guest\n")
    return 124


def alive():
    try:
        return time.time() - float(open(os.path.join(DIR, "seen")).read()) < 10
    except Exception:
        return False


if __name__ == "__main__":
    op = sys.argv[1]
    if op == "serve":
        serve()
    elif op == "run":
        sys.exit(run(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 600))
    elif op == "alive":
        sys.exit(0 if alive() else 1)
