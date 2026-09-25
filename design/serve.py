#!/usr/bin/env python
"""
Creator Studio F3 UI Design Prototype Server
Serves the standalone interactive UI design prototype for inspecting the F3 UI/UX design.

Usage:
    python design/serve.py [--no-open] [--port PORT]
"""

import sys
import os
import argparse
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
import socket

DEFAULT_PORT = 3000

class DesignPrototypeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable caching-free inspection for rapid iteration
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        sys.stderr.write(f"[F3-UI-PROTOTYPE] {self.address_string()} - {format % args}\n")

def find_open_port(start_port=DEFAULT_PORT, max_attempts=50):
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    return start_port

def main():
    parser = argparse.ArgumentParser(description="Serve the Creator Studio F3 UI Design Prototype.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on")
    parser.add_argument("--no-open", action="store_true", help="Do not automatically open default browser")
    args = parser.parse_args()

    # Ensure working directory is the design/ directory
    current_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(current_dir)

    port = find_open_port(args.port)
    server_address = ('127.0.0.1', port)
    url = f"http://localhost:{port}/"

    try:
        httpd = HTTPServer(server_address, DesignPrototypeHandler)
    except Exception as e:
        sys.stderr.write(f"Error starting server on port {port}: {e}\n")
        sys.exit(1)

    print("\n" + "=" * 65)
    print("  Creator Studio F3 -- UI/UX Interactive Design Prototype")
    print(f"  Spec: docs/superpowers/specs/2026-09-25-creator-studio-f3-full-ui-ux-design.md")
    print("=" * 65)
    print(f"  -> Local URL:  {url}")
    print(f"  -> Directory:  {current_dir}")
    print(f"  -> Mode:       Standalone Prototype (Zero External Dependencies)")
    print("=" * 65)
    print("  Press Ctrl+C to stop the server.\n")

    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[F3-UI-PROTOTYPE] Server stopped.")
        httpd.server_close()

if __name__ == "__main__":
    main()
