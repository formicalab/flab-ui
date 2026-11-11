// Human-readable names for strongSwan / IANA algorithm identifiers.

// strongSwan DH/KE transform names -> IANA group numbers (RFC 3526 MODP, RFC 5903/8031 ECP and Curve*).
const DH_GROUP = {
  MODP_768: 1, MODP_1024: 2, MODP_1536: 5, MODP_2048: 14, MODP_3072: 15, MODP_4096: 16, MODP_6144: 17, MODP_8192: 18,
  ECP_256: 19, ECP_384: 20, ECP_521: 21, ECP_224: 26, CURVE_25519: 31, CURVE_448: 32,
};

// "AES_GCM_16" + 256 -> "AES-256-GCM"; shorter ICVs are appended (AES-256-GCM-96).
export function encName(alg, keysize) {
  if (!alg) return '–';
  let m = alg.match(/^AES_(GCM|CCM)_(\d+)$/);
  if (m) return `AES-${keysize ?? '?'}-${m[1]}${m[2] === '16' ? '' : '-' + m[2] * 8}`;
  m = alg.match(/^AES_(CBC|CTR)$/);
  if (m) return `AES-${keysize ?? '?'}-${m[1]}`;
  if (alg === 'CHACHA20_POLY1305') return 'ChaCha20-Poly1305';
  return alg.replace(/_/g, '-');
}

// True for authenticated-encryption ciphers, which carry their own integrity (no separate integ algorithm).
export const isAead = alg => /GCM|CCM|CHACHA20/.test(alg ?? '');

// "PRF_HMAC_SHA2_384" -> "HMAC-SHA-384"; also used for integrity names such as "HMAC_SHA2_256_128".
export function hashName(name) {
  if (!name) return '–';
  const m = name.replace(/^PRF_/, '').match(/^HMAC_SHA(\d)_(\d+)(?:_(\d+))?$/);
  if (m) return `HMAC-SHA-${m[2]}${m[3] ? '-' + m[3] : ''}`;
  return name.replace(/^PRF_/, '').replace(/_/g, '-');
}

// "ECP_384" -> "ECP-384 · group 20".
export function keName(name) {
  if (!name) return 'none';
  const group = DH_GROUP[name];
  return `${name.replace(/_/g, '-')}${group ? ` · group ${group}` : ''}`;
}

// Authentication class reported by strongSwan ("pre-shared key", "public key"...) as a plain label.
export function authName(cls) {
  if (!cls) return '–';
  if (/pre-shared/i.test(cls)) return 'Pre-shared key';
  if (/public key/i.test(cls)) return 'Certificate';
  return cls;
}

// Badge kind for a connection's session or SA state (strongSwan state names).
export const stateKind = s => s === 'ESTABLISHED' || s === 'INSTALLED' ? 'success'
  : s === 'DOWN' || s === 'DELETING' ? 'danger' : 'warning';
