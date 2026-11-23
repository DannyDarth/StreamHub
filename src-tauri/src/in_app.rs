//! "Play in StreamHub": Streamlink writes the stream to its stdout (`--stdout`) instead of starting
//! a player, and this local server hands it to StreamHub's own player (mpegts.js in the UI).
//!
//! Streamlink (and the ad blocking plugin, proxy switching and backup stream) works exactly as with
//! an external player; only the last step differs. The server listens on 127.0.0.1 only, on a
//! random port, and serves one stream: when Streamlink restarts (switching proxies) the player
//! reconnects and gets the new process's output.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::ChildStdout;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// The current Streamlink process's stdout, waiting for the player to connect.
#[derive(Default)]
pub struct StreamSlot {
    stdout: Mutex<Option<ChildStdout>>,
    ready: Condvar,
    /// Set when the stream session is over: the server stops.
    pub closed: AtomicBool,
}

impl StreamSlot {
    /// Hand over a new Streamlink process's stdout (after a start or a restart).
    pub fn put(&self, stdout: ChildStdout) {
        *self.stdout.lock().unwrap() = Some(stdout);
        self.ready.notify_all();
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.stdout.lock().unwrap().take();
        self.ready.notify_all();
    }

    /// Wait for a stdout to serve (None when the session is over or nothing came in time).
    fn take(&self, timeout: Duration) -> Option<ChildStdout> {
        let guard = self.stdout.lock().unwrap();
        let (mut guard, _) = self
            .ready
            .wait_timeout_while(guard, timeout, |s| s.is_none() && !self.closed.load(Ordering::SeqCst))
            .unwrap();
        guard.take()
    }

    fn give_back(&self, stdout: ChildStdout) {
        let mut slot = self.stdout.lock().unwrap();
        if slot.is_none() && !self.closed.load(Ordering::SeqCst) {
            *slot = Some(stdout);
            self.ready.notify_all();
        }
    }
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n";

/// Read the request line and headers; returns the method.
fn read_request(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let method = line.split_whitespace().next()?.to_string();
    let mut header = String::new();
    while reader.read_line(&mut header).ok()? > 2 {
        header.clear();
    }
    Some(method)
}

fn serve(mut stream: TcpStream, slot: &StreamSlot) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Some(method) = read_request(&stream) else { return };
    if method == "OPTIONS" {
        let _ = write!(stream, "HTTP/1.1 204 No Content\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    if method != "GET" {
        let _ = write!(stream, "HTTP/1.1 405 Method Not Allowed\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let Some(mut stdout) = slot.take(Duration::from_secs(60)) else {
        let _ = write!(stream, "HTTP/1.1 503 Service Unavailable\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    if write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nCache-Control: no-store\r\n{CORS}Connection: close\r\n\r\n"
    )
    .is_err()
    {
        slot.give_back(stdout);
        return;
    }
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match stdout.read(&mut buf) {
            Ok(0) | Err(_) => return, // Streamlink ended or restarted
            Ok(n) => n,
        };
        if stream.write_all(&buf[..n]).is_err() {
            // the player went away (e.g. it reconnects): keep the stream for the next connection
            slot.give_back(stdout);
            return;
        }
    }
}

/// Start the local stream server. Returns its URL.
pub fn start(slot: Arc<StreamSlot>) -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    std::thread::spawn(move || {
        while !slot.closed.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let slot = slot.clone();
                    std::thread::spawn(move || serve(stream, &slot));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
    });
    Ok(format!("http://127.0.0.1:{port}/stream.ts"))
}
