// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use rand::Rng;
use sha2::{Digest, Sha256};

use crate::error::{AuthError, Result};

/// 256-bit symmetric vault key used for encrypting TOTP secrets and stored credentials at rest.
#[derive(Clone)]
pub struct VaultKey {
    key: [u8; 32],
}

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultKey").finish_non_exhaustive()
    }
}

impl VaultKey {
    /// Creates a `VaultKey` directly from 32 raw bytes (useful in tests).
    #[must_use]
    pub fn from_bytes(key: [u8; 32]) -> Self {
        Self { key }
    }

    /// Generates an ephemeral random key (useful for in-memory test instances).
    #[must_use]
    pub fn ephemeral() -> Self {
        let mut key = [0u8; 32];
        UnwrapErr(SysRng).fill_bytes(&mut key);
        Self { key }
    }

    /// Loads or creates the vault master key from `ARIMA_MASTER_KEY` or `<data_dir>/vault.key` (`0600`).
    pub fn load_or_create(data_dir: Option<&Path>) -> Result<Self> {
        if let Ok(env_key) = std::env::var("ARIMA_MASTER_KEY") {
            let trimmed = env_key.trim();
            if !trimmed.is_empty() {
                if let Ok(raw) = hex::decode(trimmed) {
                    if raw.len() == 32 {
                        let mut key = [0u8; 32];
                        key.copy_from_slice(&raw);
                        return Ok(Self { key });
                    }
                }
                let digest = Sha256::digest(trimmed.as_bytes());
                let mut key = [0u8; 32];
                key.copy_from_slice(&digest);
                return Ok(Self { key });
            }
        }

        let Some(dir) = data_dir else {
            return Ok(Self::ephemeral());
        };
        fs::create_dir_all(dir)?;
        let key_path = dir.join("vault.key");
        if key_path.exists() {
            let contents = fs::read_to_string(&key_path)?;
            let raw = hex::decode(contents.trim())
                .map_err(|_| AuthError::Crypto("corrupt vault.key hex".into()))?;
            if raw.len() != 32 {
                return Err(AuthError::Crypto("invalid vault.key length".into()));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&raw);
            return Ok(Self { key });
        }

        let mut key = [0u8; 32];
        UnwrapErr(SysRng).fill_bytes(&mut key);
        let hex_key = hex::encode(key);

        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let tmp = dir.join(".vault.key.tmp");
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(hex_key.as_bytes())?;
            file.sync_all()?;
            fs::rename(tmp, &key_path)?;
        }
        #[cfg(not(unix))]
        {
            fs::write(&key_path, hex_key)?;
        }

        Ok(Self { key })
    }

    /// Derives a domain-separated 256-bit subkey without exposing the raw vault master key.
    #[must_use]
    pub fn derive_subkey(&self, context: &[u8]) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"arima-vault-subkey-v1:");
        hasher.update((context.len() as u64).to_be_bytes());
        hasher.update(context);
        hasher.update(self.key);
        let digest = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    /// Encrypts `plaintext` with AES-256-GCM bound to `aad`, returning `<nonce_hex>:<ct_hex>`.
    pub fn encrypt(&self, aad: &[u8], plaintext: &[u8]) -> Result<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| AuthError::Crypto(format!("cipher init failed: {e}")))?;
        let mut nonce_bytes = [0u8; 12];
        UnwrapErr(SysRng).fill_bytes(&mut nonce_bytes);
        let nonce = &Nonce::from(nonce_bytes);
        let ct = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|e| AuthError::Crypto(format!("encrypt failed: {e}")))?;
        Ok(format!("{}:{}", hex::encode(nonce_bytes), hex::encode(ct)))
    }

    /// Decrypts `<nonce_hex>:<ct_hex>` encrypted by [`Self::encrypt`] with matching `aad`.
    pub fn decrypt(&self, aad: &[u8], encoded: &str) -> Result<Vec<u8>> {
        let Some((nonce_hex, ct_hex)) = encoded.split_once(':') else {
            return Err(AuthError::Crypto("malformed ciphertext envelope".into()));
        };
        let nonce_raw =
            hex::decode(nonce_hex).map_err(|_| AuthError::Crypto("bad nonce hex".into()))?;
        if nonce_raw.len() != 12 {
            return Err(AuthError::Crypto("bad nonce length".into()));
        }
        let ct = hex::decode(ct_hex).map_err(|_| AuthError::Crypto("bad ciphertext hex".into()))?;
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| AuthError::Crypto(format!("cipher init failed: {e}")))?;
        let nonce = &Nonce::try_from(nonce_raw.as_slice())
            .map_err(|_| AuthError::Crypto("bad nonce length".into()))?;
        cipher
            .decrypt(nonce, Payload { msg: &ct, aad })
            .map_err(|_| AuthError::Crypto("decryption failed".into()))
    }
}
