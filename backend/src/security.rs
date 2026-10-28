//! Pengamanan dasar: batas percobaan login per IP & IP client.

use axum::http::HeaderMap;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Maksimal percobaan login gagal per IP dalam `WINDOW`, lalu dikunci `LOCKOUT`.
const MAX_ATTEMPTS: u32 = 5;
const WINDOW: Duration = Duration::from_secs(15 * 60);
const LOCKOUT: Duration = Duration::from_secs(15 * 60);
/// Batas jumlah IP yang diingat, supaya memori tidak bisa dibanjiri.
const MAX_TRACKED: usize = 10_000;

struct Attempts {
    count: u32,
    first_at: Instant,
    locked_until: Option<Instant>,
}

/// Membatasi percobaan login per IP.
///
/// Percobaan dihitung SEBELUM password dicek (`begin`) dan baru dihapus jika
/// berhasil (`success`). Jadi 100 request paralel tetap hanya mendapat
/// `MAX_ATTEMPTS` kesempatan, dan Argon2 tidak dijalankan untuk IP yang dikunci.
#[derive(Default)]
pub struct LoginLimiter {
    attempts: Mutex<HashMap<IpAddr, Attempts>>,
}

impl LoginLimiter {
    /// `Err(sisa waktu)` jika IP sedang dikunci.
    pub fn begin(&self, ip: IpAddr) -> Result<(), Duration> {
        self.begin_at(ip, Instant::now())
    }

    pub fn success(&self, ip: IpAddr) {
        self.attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&ip);
    }

    fn begin_at(&self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        let mut map = self.attempts.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_TRACKED && !map.contains_key(&ip) {
            map.retain(|_, a| {
                a.locked_until.is_some_and(|t| t > now) || now - a.first_at < WINDOW
            });
        }

        let entry = map.entry(ip).or_insert(Attempts {
            count: 0,
            first_at: now,
            locked_until: None,
        });
        if let Some(until) = entry.locked_until {
            if until > now {
                return Err(until - now);
            }
            entry.locked_until = None;
            entry.count = 0;
            entry.first_at = now;
        }
        if now - entry.first_at >= WINDOW {
            entry.count = 0;
            entry.first_at = now;
        }

        entry.count += 1;
        if entry.count > MAX_ATTEMPTS {
            entry.locked_until = Some(now + LOCKOUT);
            return Err(LOCKOUT);
        }
        Ok(())
    }
}

/// IP client. Dengan `trust_proxy` (server di belakang Nginx/Caddy), dipakai
/// entri TERAKHIR `X-Forwarded-For`, yaitu yang ditambahkan proxy kita sendiri;
/// entri sebelumnya bisa dikarang client.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr, trust_proxy: bool) -> IpAddr {
    if trust_proxy {
        let forwarded = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .filter_map(|s| s.trim().parse::<IpAddr>().ok())
            .next_back();
        if let Some(ip) = forwarded {
            return ip;
        }
    }
    peer.ip()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn locks_after_max_attempts_and_unlocks_later() {
        let limiter = LoginLimiter::default();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let other: IpAddr = "10.0.0.2".parse().unwrap();
        let t0 = Instant::now();

        for _ in 0..MAX_ATTEMPTS {
            assert!(limiter.begin_at(ip, t0).is_ok());
        }
        assert_eq!(limiter.begin_at(ip, t0), Err(LOCKOUT));
        // Masih terkunci, sisa waktu berkurang
        let later = t0 + Duration::from_secs(60);
        assert_eq!(limiter.begin_at(ip, later), Err(LOCKOUT - Duration::from_secs(60)));
        // IP lain tidak terpengaruh
        assert!(limiter.begin_at(other, later).is_ok());
        // Setelah LOCKOUT selesai boleh mencoba lagi
        assert!(limiter.begin_at(ip, t0 + LOCKOUT + Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn success_resets_and_window_expires() {
        let limiter = LoginLimiter::default();
        let ip: IpAddr = "::1".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..MAX_ATTEMPTS {
            limiter.begin_at(ip, t0).unwrap();
        }
        limiter.success(ip);
        assert!(limiter.begin_at(ip, t0).is_ok());

        // Gagal tersebar lebih lama dari WINDOW tidak menyebabkan kunci
        let limiter = LoginLimiter::default();
        for i in 0..(MAX_ATTEMPTS * 3) {
            let t = t0 + (WINDOW / MAX_ATTEMPTS) * (i + 1);
            assert!(limiter.begin_at(ip, t).is_ok(), "percobaan ke-{i}");
        }
    }

    #[test]
    fn client_ip_from_proxy_header() {
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.1.1.1, 203.0.113.9"),
        );
        assert_eq!(client_ip(&headers, peer, false), peer.ip());
        assert_eq!(
            client_ip(&headers, peer, true),
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );
        assert_eq!(client_ip(&HeaderMap::new(), peer, true), peer.ip());
    }
}
