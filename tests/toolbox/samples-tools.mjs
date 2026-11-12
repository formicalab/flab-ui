// The output of the connectivity check, the DNS comparison and the certificate check as the main router printed them
// (captured 2026-11-12 on the GL-MT6000; the certificates' base64 bodies are cut to two lines). The self-signed,
// expired and reset cases are real answers of badssl.com. Shared by the Diagnostics unit test and the browser test.
export const TLS_LOCAL = `### BEGIN tls 492261.10 127.0.0.1 443
Connecting to 127.0.0.1
CONNECTED(00000003)
Can't use SSL_get_servername
depth=0 CN=openwrt.lab.formicalab.casa
verify error:num=64:IP address mismatch
verify return:1
depth=3 C=US, O=Internet Security Research Group, CN=ISRG Root X1
verify return:1
depth=2 C=US, O=ISRG, CN=Root YR
verify return:1
depth=1 C=US, O=Let's Encrypt, CN=YR2
verify return:1
depth=0 CN=openwrt.lab.formicalab.casa
verify return:1
---
Certificate chain
 0 s:CN=openwrt.lab.formicalab.casa
   i:C=US, O=Let's Encrypt, CN=YR2
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Oct 24 21:02:04 2026 GMT; NotAfter: Jan 22 21:02:03 2027 GMT
-----BEGIN CERTIFICATE-----
MIIFETCCA/mgAwIBAgISBYVd7iY9qUGOcEHb7E+4O/ejMA0GCSqGSIb3DQEBCwUA
MDMxCzAJBgNVBAYTAlVTMRYwFAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQD
-----END CERTIFICATE-----
 1 s:C=US, O=Let's Encrypt, CN=YR2
   i:C=US, O=ISRG, CN=Root YR
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Sep  3 00:00:00 2025 GMT; NotAfter: Sep  2 23:59:59 2028 GMT
-----BEGIN CERTIFICATE-----
MIIE2jCCAsKgAwIBAgIQTr0klH4k05SALYSlL9WzGTANBgkqhkiG9w0BAQsFADAu
MQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZUjAe
-----END CERTIFICATE-----
 2 s:C=US, O=ISRG, CN=Root YR
   i:C=US, O=Internet Security Research Group, CN=ISRG Root X1
   a:PKEY: RSA, 4096 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: May 13 00:00:00 2026 GMT; NotAfter: Sep  2 23:59:59 2032 GMT
-----BEGIN CERTIFICATE-----
MIIF9DCCA9ygAwIBAgIRAPJLbRf52a18scn+p4eCaZ8wDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
-----END CERTIFICATE-----
---
Server certificate
subject=CN=openwrt.lab.formicalab.casa
issuer=C=US, O=Let's Encrypt, CN=YR2
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: rsa_pss_rsae_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 5713 bytes and written 1588 bytes
Verification error: IP address mismatch
---
New, TLSv1.3, Cipher is TLS_CHACHA20_POLY1305_SHA256
Protocol: TLSv1.3
Server public key is 2048 bit
This TLS version forbids renegotiation.
No ALPN negotiated
Early data was not sent
Verify return code: 64 (IP address mismatch)
---
DONE
### CERT 1
serial=05855DEE263DA9418E7041DBEC4FB83BF7A3
sha256 Fingerprint=6A:32:3A:23:9D:4E:BA:60:BE:6E:4F:2C:F6:6B:F8:38:BD:B6:8C:21:DF:D3:07:37:76:3F:D7:20:63:B7:F8:AA
X509v3 Basic Constraints: critical
    CA:FALSE
X509v3 Subject Alternative Name: 
    DNS:openwrt.lab.formicalab.casa
### CERT 2
serial=4EBD24947E24D394802D84A52FD5B319
sha256 Fingerprint=23:8B:85:A0:09:9C:65:B9:70:47:7D:57:24:F1:A1:D4:75:CE:50:58:CF:FE:4E:FA:87:33:89:9B:DB:86:3C:47
X509v3 Basic Constraints: critical
    CA:TRUE, pathlen:0
### CERT 3
serial=F24B6D17F9D9AD7CB1C9FEA78782699F
sha256 Fingerprint=07:26:39:D0:B1:40:D5:BF:FA:E1:6A:D9:C3:F6:CC:60:86:04:06:21:F5:1E:E6:1A:6D:46:A8:91:5C:07:CF:76
X509v3 Basic Constraints: critical
    CA:TRUE

### END 0 492261.55
`;
export const TLS_EXAMPLE = `### BEGIN tls 492266.19 example.com 443
Connecting to 2606:4700:10::6814:179a
CONNECTED(00000003)
depth=3 C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
verify return:1
depth=2 C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
verify return:1
depth=1 C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
verify return:1
depth=0 CN=example.com
verify return:1
---
Certificate chain
 0 s:CN=example.com
   i:C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256
   v:NotBefore: Sep 26 22:49:11 2026 GMT; NotAfter: Dec 25 22:56:35 2026 GMT
-----BEGIN CERTIFICATE-----
MIID5jCCA42gAwIBAgIQAe7mqrtSHV4U/DFf2ZhWkDAKBggqhkjOPQQDAjBRMQsw
CQYDVQQGEwJVUzEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMSgwJgYDVQQDDB9D
-----END CERTIFICATE-----
 1 s:C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
   i:C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA384
   v:NotBefore: May 29 19:49:45 2025 GMT; NotAfter: May 27 19:49:44 2035 GMT
-----BEGIN CERTIFICATE-----
MIIC4jCCAmmgAwIBAgIQMe7oivuHzZ74M2YEdD+bJzAKBggqhkjOPQQDAzBPMQsw
CQYDVQQGEwJVUzEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMSYwJAYDVQQDDB1T
-----END CERTIFICATE-----
 2 s:C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
   i:C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
   a:PKEY: EC, (secp384r1); sigalg: ecdsa-with-SHA384
   v:NotBefore: Oct 21 17:02:23 2022 GMT; NotAfter: Oct 17 17:02:22 2037 GMT
-----BEGIN CERTIFICATE-----
MIIDNDCCArmgAwIBAgIQYE2K+NALqHSLlVhTFyxfLjAKBggqhkjOPQQDAzBOMQsw
CQYDVQQGEwJVUzEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMSUwIwYDVQQDDBxT
-----END CERTIFICATE-----
 3 s:C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
   i:C=GB, ST=Greater Manchester, L=Salford, O=Comodo CA Limited, CN=AAA Certificate Services
   a:PKEY: EC, (secp384r1); sigalg: sha256WithRSAEncryption
   v:NotBefore: Aug  1 00:00:00 2025 GMT; NotAfter: Dec 31 23:59:59 2028 GMT
-----BEGIN CERTIFICATE-----
MIIEPjCCAyagAwIBAgIQFz3KYOqfjhAm2vzXKBDkjjANBgkqhkiG9w0BAQsFADB7
MQswCQYDVQQGEwJHQjEbMBkGA1UECAwSR3JlYXRlciBNYW5jaGVzdGVyMRAwDgYD
-----END CERTIFICATE-----
---
Server certificate
subject=CN=example.com
issuer=C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: ecdsa_secp256r1_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 5071 bytes and written 1624 bytes
Verification: OK
Verified peername: example.com
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 256 bit
This TLS version forbids renegotiation.
No ALPN negotiated
Early data was not sent
Verify return code: 0 (ok)
---
DONE
### CERT 1
serial=01EEE6AABB521D5E14FC315FD9985690
sha256 Fingerprint=85:CA:6A:B0:68:E9:BC:CE:88:B6:C4:AA:3C:47:F7:D1:72:28:13:4A:45:7F:87:0D:38:00:E6:22:3A:0D:F0:7A
X509v3 Basic Constraints: critical
    CA:FALSE
X509v3 Subject Alternative Name: 
    DNS:example.com, DNS:*.example.com
### CERT 2
serial=31EEE88AFB87CD9EF8336604743F9B27
sha256 Fingerprint=F1:5F:29:AB:EF:73:AA:4D:D9:AB:75:4B:AE:AE:36:85:BD:D3:87:4B:46:B5:25:07:11:77:62:86:85:71:80:26
X509v3 Basic Constraints: critical
    CA:TRUE, pathlen:0
### CERT 3
serial=604D8AF8D00BA8748B955853172C5F2E
sha256 Fingerprint=5D:1B:C3:99:27:4E:64:9E:1C:72:69:7D:E9:1A:54:AD:72:50:88:C5:22:1C:B6:1E:17:EE:9C:29:0B:C4:2A:92
X509v3 Basic Constraints: critical
    CA:TRUE, pathlen:1
### CERT 4
serial=173DCA60EA9F8E1026DAFCD72810E48E
sha256 Fingerprint=BA:06:D3:D3:E3:48:FC:E7:47:8C:C8:4B:42:2D:0E:63:8E:9E:22:1E:F1:A0:B5:3A:DC:14:CC:70:E0:4B:8A:B8
X509v3 Basic Constraints: critical
    CA:TRUE, pathlen:2

### END 0 492266.80
`;
export const TLS_EXPIRED = `### BEGIN tls 492272.28 expired.badssl.com 443
Connecting to 104.154.89.105
CONNECTED(00000003)
depth=2 C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Certification Authority
verify return:1
depth=1 C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Domain Validation Secure Server CA
verify return:1
depth=0 OU=Domain Control Validated, OU=PositiveSSL Wildcard, CN=*.badssl.com
verify error:num=10:certificate has expired
notAfter=Apr 12 23:59:59 2015 GMT
verify return:1
depth=0 OU=Domain Control Validated, OU=PositiveSSL Wildcard, CN=*.badssl.com
notAfter=Apr 12 23:59:59 2015 GMT
verify return:1
---
Certificate chain
 0 s:OU=Domain Control Validated, OU=PositiveSSL Wildcard, CN=*.badssl.com
   i:C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Domain Validation Secure Server CA
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Apr  9 00:00:00 2015 GMT; NotAfter: Apr 12 23:59:59 2015 GMT
-----BEGIN CERTIFICATE-----
MIIFSzCCBDOgAwIBAgIQSueVSfqavj8QDxekeOFpCTANBgkqhkiG9w0BAQsFADCB
kDELMAkGA1UEBhMCR0IxGzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4G
-----END CERTIFICATE-----
 1 s:C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Domain Validation Secure Server CA
   i:C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Certification Authority
   a:PKEY: RSA, 2048 (bit); sigalg: sha384WithRSAEncryption
   v:NotBefore: Feb 12 00:00:00 2014 GMT; NotAfter: Feb 11 23:59:59 2029 GMT
-----BEGIN CERTIFICATE-----
MIIGCDCCA/CgAwIBAgIQKy5u6tl1NmwUim7bo3yMBzANBgkqhkiG9w0BAQwFADCB
hTELMAkGA1UEBhMCR0IxGzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4G
-----END CERTIFICATE-----
 2 s:C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Certification Authority
   i:C=SE, O=AddTrust AB, OU=AddTrust External TTP Network, CN=AddTrust External CA Root
   a:PKEY: RSA, 4096 (bit); sigalg: sha384WithRSAEncryption
   v:NotBefore: May 30 10:48:38 2000 GMT; NotAfter: May 30 10:48:38 2020 GMT
-----BEGIN CERTIFICATE-----
MIIFdDCCBFygAwIBAgIQJ2buVutJ846r13Ci/ITeIjANBgkqhkiG9w0BAQwFADBv
MQswCQYDVQQGEwJTRTEUMBIGA1UEChMLQWRkVHJ1c3QgQUIxJjAkBgNVBAsTHUFk
-----END CERTIFICATE-----
---
Server certificate
subject=OU=Domain Control Validated, OU=PositiveSSL Wildcard, CN=*.badssl.com
issuer=C=GB, ST=Greater Manchester, L=Salford, O=COMODO CA Limited, CN=COMODO RSA Domain Validation Secure Server CA
---
No client certificate CA names sent
Peer signing digest: SHA512
Peer signature type: rsa_pkcs1_sha512
Peer Temp Key: ECDH, prime256v1, 256 bits
---
SSL handshake has read 5003 bytes and written 1677 bytes
Verification error: certificate has expired
---
New, TLSv1.2, Cipher is ECDHE-RSA-AES128-GCM-SHA256
Protocol: TLSv1.2
Server public key is 2048 bit
Secure Renegotiation IS supported
No ALPN negotiated
SSL-Session:
    Protocol  : TLSv1.2
    Cipher    : ECDHE-RSA-AES128-GCM-SHA256
    Session-ID: 7DAC0F7A961107DE2D22627CB214F230E5F809C8F2A41BD25A8D5EF62648FA4D
    Session-ID-ctx: 
    Master-Key: 53CF1CD930A3D64DCC2378419A9A2C02CE397FA5A8BC81F6A201E1B850159BA4AA7934E839FBFDA1A33BCDAF3E101CAC
    PSK identity: None
    PSK identity hint: None
    SRP username: None
    TLS session ticket lifetime hint: 300 (seconds)
    TLS session ticket:
    0000 - 60 2c 63 a2 33 d2 88 ad-cb 1c 6e 6e 1f c3 b0 50   \`,c.3.....nn...P
    0010 - 18 00 4e a9 2e 84 96 11-9b 8f 21 75 1e 71 1c 85   ..N.......!u.q..
    0020 - 8f d1 b0 86 e8 6a ef ea-89 17 fc 54 e5 04 00 ea   .....j.....T....
    0030 - 61 6f 4c 60 52 7b 6a d0-1c 26 f5 21 17 28 40 0f   aoL\`R{j..&.!.(@.
    0040 - 27 09 b6 cd 6d 21 d0 a9-ec 42 a5 ce ce 81 d1 4e   '...m!...B.....N
    0050 - cf 55 66 63 3b 95 bc 15-bd 6e 54 48 a4 ca d5 70   .Ufc;....nTH...p
    0060 - 18 af 73 4c 61 52 18 18-db b1 e5 e6 58 61 a5 2b   ..sLaR......Xa.+
    0070 - 0b 9b 2d 8c 7f 8b de d2-1b 77 57 79 7b 22 1d c8   ..-......wWy{"..
    0080 - 93 19 74 0c 63 99 56 7f-7e 7b cf 7b a6 2a 25 b9   ..t.c.V.~{.{.*%.
    0090 - b9 2c 2c 46 0d 17 e9 b2-c2 0b 72 be 47 33 96 ca   .,,F......r.G3..
    00a0 - 1b f6 4d 30 bb f7 71 c8-7c c1 f0 21 83 ee 99 00   ..M0..q.|..!....
    00b0 - fa b1 15 e2 e8 1c 01 03-79 10 16 1a ec fe 94 55   ........y......U

    Start Time: 1794469436
    Timeout   : 7200 (sec)
    Verify return code: 10 (certificate has expired)
    Extended master secret: no
---
DONE
### CERT 1
serial=4AE79549FA9ABE3F100F17A478E16909
sha256 Fingerprint=BA:10:5C:E0:2B:AC:76:88:8E:CE:E4:7C:D4:EB:79:41:65:3E:9A:C9:93:B6:1B:2E:B3:DC:C8:20:14:D2:1B:4F
X509v3 Basic Constraints: critical
    CA:FALSE
X509v3 Subject Alternative Name: 
    DNS:*.badssl.com, DNS:badssl.com
### CERT 2
serial=2B2E6EEAD975366C148A6EDBA37C8C07
sha256 Fingerprint=02:AB:57:E4:E6:7A:0C:B4:8D:D2:FF:34:83:0E:8A:C4:0F:44:76:FB:08:CA:6B:E3:F5:CD:84:6F:64:68:40:F0
X509v3 Basic Constraints: critical
    CA:TRUE, pathlen:0
### CERT 3
serial=2766EE56EB49F38EABD770A2FC84DE22
sha256 Fingerprint=4F:32:D5:DC:00:F7:15:25:0A:BC:C4:86:51:1E:37:F5:01:A8:99:DE:B3:BF:7E:A8:AD:BB:D3:AE:F1:C4:12:DA
X509v3 Basic Constraints: critical
    CA:TRUE

### END 0 492273.50
`;
export const TLS_LEAFONLY = `### BEGIN tls 505102.44 127.0.0.1 24433
Connecting to 127.0.0.1
CONNECTED(00000003)
depth=0 CN=localhost
verify error:num=20:unable to get local issuer certificate
verify return:1
depth=0 CN=localhost
verify error:num=64:IP address mismatch
verify return:1
depth=0 CN=localhost
verify error:num=21:unable to verify the first certificate
verify return:1
depth=0 CN=localhost
verify return:1
---
Certificate chain
 0 s:CN=localhost
   i:O=Example Lab, CN=Example Lab Issuing CA
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256
   v:NotBefore: Nov 12 11:17:45 2026 GMT; NotAfter: Dec 12 11:17:45 2026 GMT
-----BEGIN CERTIFICATE-----
MIIBpjCCAUugAwIBAgIUUe7Usnm+BBpitl303TqCU0BOv0AwCgYIKoZIzj0EAwIw
NzEUMBIGA1UECgwLRXhhbXBsZSBMYWIxHzAdBgNVBAMMFkV4YW1wbGUgTGFiIElz
c3VpbmcgQ0EwHhcNMjYxMTEyMTExNzQ1WhcNMjYxMjEyMTExNzQ1WjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASCn5DgP4LR
t8i7DFx/+vgqpC6xFCrup55qUNI4qWvhABoAm3uXNpf8o+d/0quHF8XoALMze0K6
lMg12rnFjuPso1gwVjAUBgNVHREEDTALgglsb2NhbGhvc3QwHQYDVR0OBBYEFCVk
Q+XxVZZEzRp0gyO2NVdFJGoaMB8GA1UdIwQYMBaAFPf+8DepeezpcyEYmqBXbD0D
J3cMMAoGCCqGSM49BAMCA0kAMEYCIQDk3oLupcvG+rme9qohJm4YcPIbkiNnpq0s
I2Lt4CBySgIhALjhDxzOvJqpSGerR9Zhdr1smYEvnZWV/52gjMFo5xBa
-----END CERTIFICATE-----
---
Server certificate
subject=CN=localhost
issuer=O=Example Lab, CN=Example Lab Issuing CA
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: ecdsa_secp256r1_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 1886 bytes and written 1622 bytes
Verification error: unable to verify the first certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 256 bit
This TLS version forbids renegotiation.
No ALPN negotiated
Early data was not sent
Verify return code: 21 (unable to verify the first certificate)
---
DONE
### CERT 1
serial=51EED4B279BE041A62B65DF4DD3A8253404EBF40
sha256 Fingerprint=65:F5:27:FB:CA:62:BA:06:99:62:37:48:EA:88:01:10:DB:F1:C6:A5:7A:3C:56:BF:F4:71:3C:2F:BA:4F:0C:54
X509v3 Subject Alternative Name: 
    DNS:localhost

### END 0 505102.65
`;
export const TLS_GAP = `### BEGIN tls 505106.60 127.0.0.1 24434
Connecting to 127.0.0.1
CONNECTED(00000003)
depth=0 CN=localhost
verify error:num=20:unable to get local issuer certificate
verify return:1
depth=0 CN=localhost
verify error:num=64:IP address mismatch
verify return:1
depth=0 CN=localhost
verify error:num=21:unable to verify the first certificate
verify return:1
depth=0 CN=localhost
verify return:1
---
Certificate chain
 0 s:CN=localhost
   i:O=Example Lab, CN=Example Lab Issuing CA
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256
   v:NotBefore: Nov 12 11:17:45 2026 GMT; NotAfter: Dec 12 11:17:45 2026 GMT
-----BEGIN CERTIFICATE-----
MIIBpjCCAUugAwIBAgIUUe7Usnm+BBpitl303TqCU0BOv0AwCgYIKoZIzj0EAwIw
NzEUMBIGA1UECgwLRXhhbXBsZSBMYWIxHzAdBgNVBAMMFkV4YW1wbGUgTGFiIElz
c3VpbmcgQ0EwHhcNMjYxMTEyMTExNzQ1WhcNMjYxMjEyMTExNzQ1WjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASCn5DgP4LR
t8i7DFx/+vgqpC6xFCrup55qUNI4qWvhABoAm3uXNpf8o+d/0quHF8XoALMze0K6
lMg12rnFjuPso1gwVjAUBgNVHREEDTALgglsb2NhbGhvc3QwHQYDVR0OBBYEFCVk
Q+XxVZZEzRp0gyO2NVdFJGoaMB8GA1UdIwQYMBaAFPf+8DepeezpcyEYmqBXbD0D
J3cMMAoGCCqGSM49BAMCA0kAMEYCIQDk3oLupcvG+rme9qohJm4YcPIbkiNnpq0s
I2Lt4CBySgIhALjhDxzOvJqpSGerR9Zhdr1smYEvnZWV/52gjMFo5xBa
-----END CERTIFICATE-----
 1 s:O=Example Lab, CN=Example Lab Root
   i:O=Example Lab, CN=Example Lab Root
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256
   v:NotBefore: Nov 12 11:17:44 2026 GMT; NotAfter: Dec 12 11:17:44 2026 GMT
-----BEGIN CERTIFICATE-----
MIIBuDCCAV2gAwIBAgIUPkiJONh9Gf7Rf0uGNEgtifTQ9ykwCgYIKoZIzj0EAwIw
MTEUMBIGA1UECgwLRXhhbXBsZSBMYWIxGTAXBgNVBAMMEEV4YW1wbGUgTGFiIFJv
b3QwHhcNMjYxMTEyMTExNzQ0WhcNMjYxMjEyMTExNzQ0WjAxMRQwEgYDVQQKDAtF
eGFtcGxlIExhYjEZMBcGA1UEAwwQRXhhbXBsZSBMYWIgUm9vdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABBNfSuSnl8qYOFtdPjXfcNbrpKtsmuq8nmmOJHrJ6EaF
7fWp0qWk6U5kaDa6FleAFOUfYYSS4oZrwXLNoi3g/B6jUzBRMB0GA1UdDgQWBBTs
rQjsO9Wo8WUUw3GdtNS3vQmZ1zAfBgNVHSMEGDAWgBTsrQjsO9Wo8WUUw3GdtNS3
vQmZ1zAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQDQAr52nZlU
w82gunK611/43EX0Nc6UhjTzHfHf5rvALQIhAMRkqfFo5SAakpDPafm9WHYO5l3P
kPXKci7/s1M5qF2s
-----END CERTIFICATE-----
---
Server certificate
subject=CN=localhost
issuer=O=Example Lab, CN=Example Lab Issuing CA
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: ecdsa_secp256r1_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 2334 bytes and written 1622 bytes
Verification error: unable to verify the first certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 256 bit
This TLS version forbids renegotiation.
No ALPN negotiated
Early data was not sent
Verify return code: 21 (unable to verify the first certificate)
---
DONE
### CERT 1
serial=51EED4B279BE041A62B65DF4DD3A8253404EBF40
sha256 Fingerprint=65:F5:27:FB:CA:62:BA:06:99:62:37:48:EA:88:01:10:DB:F1:C6:A5:7A:3C:56:BF:F4:71:3C:2F:BA:4F:0C:54
X509v3 Subject Alternative Name: 
    DNS:localhost
### CERT 2
serial=3E488938D87D19FED17F4B8634482D89F4D0F729
sha256 Fingerprint=7D:36:12:E5:19:22:98:C0:63:59:97:97:0B:42:40:23:BF:D1:EC:74:5D:76:B7:86:39:50:74:30:B4:E6:16:BA
X509v3 Basic Constraints: critical
    CA:TRUE

### END 0 505106.91
`;
export const TLS_SELFSIGNED = `### BEGIN tls 492280.38 self-signed.badssl.com 443
Connecting to 104.154.89.105
CONNECTED(00000003)
depth=0 C=US, ST=California, L=San Francisco, O=BadSSL, CN=*.badssl.com
verify error:num=18:self-signed certificate
verify return:1
depth=0 C=US, ST=California, L=San Francisco, O=BadSSL, CN=*.badssl.com
verify return:1
---
Certificate chain
 0 s:C=US, ST=California, L=San Francisco, O=BadSSL, CN=*.badssl.com
   i:C=US, ST=California, L=San Francisco, O=BadSSL, CN=*.badssl.com
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Nov 10 21:00:15 2026 GMT; NotAfter: Nov  9 21:00:15 2028 GMT
-----BEGIN CERTIFICATE-----
MIIDeTCCAmGgAwIBAgIJANgjK7l1WnucMA0GCSqGSIb3DQEBCwUAMGIxCzAJBgNV
BAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1TYW4gRnJhbmNp
-----END CERTIFICATE-----
---
Server certificate
subject=C=US, ST=California, L=San Francisco, O=BadSSL, CN=*.badssl.com
issuer=C=US, ST=California, L=San Francisco, O=BadSSL, CN=*.badssl.com
---
No client certificate CA names sent
Peer signing digest: SHA512
Peer signature type: rsa_pkcs1_sha512
Peer Temp Key: ECDH, prime256v1, 256 bits
---
SSL handshake has read 1599 bytes and written 1681 bytes
Verification error: self-signed certificate
---
New, TLSv1.2, Cipher is ECDHE-RSA-AES128-GCM-SHA256
Protocol: TLSv1.2
Server public key is 2048 bit
Secure Renegotiation IS supported
No ALPN negotiated
SSL-Session:
    Protocol  : TLSv1.2
    Cipher    : ECDHE-RSA-AES128-GCM-SHA256
    Session-ID: F65A5F57EB8AAB4DB12ACC272FF2CF2B7148C70546CAEAB780E62FB4399A08E6
    Session-ID-ctx: 
    Master-Key: B6368233639EBEF7FBAC803ED52E8D4DF64394BF1FCBE5A5D5F52222BB379EDA2513098C887B819AE52F74981F31EEAB
    PSK identity: None
    PSK identity hint: None
    SRP username: None
    TLS session ticket lifetime hint: 300 (seconds)
    TLS session ticket:
    0000 - 60 2c 63 a2 33 d2 88 ad-cb 1c 6e 6e 1f c3 b0 50   \`,c.3.....nn...P
    0010 - fa c9 4d f9 71 cc 6c aa-07 dd 6d 65 1e ee d9 5e   ..M.q.l...me...^
    0020 - 03 e5 32 02 6b 75 ad 1d-bf 3b 04 b6 5f e6 65 55   ..2.ku...;.._.eU
    0030 - c2 11 45 56 47 53 4f a6-45 33 ff 42 3b 6b 4e f2   ..EVGSO.E3.B;kN.
    0040 - fa 83 a9 32 c7 22 1e c0-2f d4 3d a6 b2 1f 9b 6e   ...2."../.=....n
    0050 - 00 9c a5 be c2 8c 6e 08-d1 a2 48 ee 4b c5 72 0d   ......n...H.K.r.
    0060 - 20 cd 99 b0 cb 5c 80 b7-38 f0 37 ca fb 26 e2 a6    ....\\..8.7..&..
    0070 - ea 57 fc 51 3b 54 ff 23-21 4b cf 67 88 f7 47 85   .W.Q;T.#!K.g..G.
    0080 - ac 3f cf 79 0d 52 23 a0-36 56 0f dd ad ef 0c 8a   .?.y.R#.6V......
    0090 - d8 df 7b 89 d2 86 d9 f9-b8 b2 4f c9 36 00 2d 43   ..{.......O.6.-C
    00a0 - 4c c3 94 07 1f 93 2e 78-ff 9e 3c 39 a7 b9 b2 51   L......x..<9...Q
    00b0 - 4d d0 31 94 dd 09 90 1e-01 76 82 67 8a ca b0 36   M.1......v.g...6
    00c0 - fe 80 5f 8b 12 2b 64 93-32 bd 47 87 05 53 c0 7a   .._..+d.2.G..S.z

    Start Time: 1794469449
    Timeout   : 7200 (sec)
    Verify return code: 18 (self-signed certificate)
    Extended master secret: no
---
DONE
### CERT 1
serial=D8232BB9755A7B9C
sha256 Fingerprint=7B:5D:AB:DE:42:DF:F9:25:9D:04:A9:90:2A:14:77:DA:DD:4C:4E:FA:E0:80:E2:0B:DC:CA:6B:A1:57:84:1E:EC
X509v3 Basic Constraints: 
    CA:FALSE
X509v3 Subject Alternative Name: 
    DNS:*.badssl.com, DNS:badssl.com

### END 0 492285.53
`;
export const TLS_RESET = `### BEGIN tls 492288.48 wrong.host.badssl.com 443
Connecting to 104.154.89.105
CONNECTED(00000003)
write:errno=104
---
no peer certificate available
---
No client certificate CA names sent
Negotiated TLS1.3 group: <NULL>
---
SSL handshake has read 0 bytes and written 1554 bytes
Verification: OK
---
New, (NONE), Cipher is (NONE)
Protocol: TLSv1.3
This TLS version forbids renegotiation.
No ALPN negotiated
Early data was not sent
Verify return code: 0 (ok)
---

### END 1 492288.90
`;
export const TLS_REFUSED = `### BEGIN tls 492296.57 127.0.0.1 9
380D39997F000000:error:8000006F:system library:BIO_connect:Connection refused:crypto/bio/bio_sock2.c:183:calling connect()
380D39997F000000:error:10000067:BIO routines:BIO_connect:connect error:crypto/bio/bio_sock2.c:185:
connect:errno=111

### END 1 492296.65
`;
export const COMPARE = `### BEGIN server 492301.96 router
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 63272
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; example.com.        		IN	A

;; ANSWER SECTION:
example.com.        	258	IN	A	104.20.23.154
example.com.        	258	IN	A	172.66.147.243

;; Received 72 B
;; Time 2026-11-12 08:44:25 CET
;; From 127.0.0.1@53(UDP) in 0.5 ms

### END 0 492301.98
### BEGIN server 492301.98 1.1.1.1
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 45720
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; example.com.        		IN	A

;; ANSWER SECTION:
example.com.        	200	IN	A	104.20.23.154
example.com.        	200	IN	A	172.66.147.243

;; Received 72 B
;; Time 2026-11-12 08:44:25 CET
;; From 1.1.1.1@53(UDP) in 9.4 ms

### END 0 492302.00
### BEGIN server 492302.00 8.8.8.8
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 21466
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 512 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; example.com.        		IN	A

;; ANSWER SECTION:
example.com.        	300	IN	A	172.66.147.243
example.com.        	300	IN	A	104.20.23.154

;; Received 72 B
;; Time 2026-11-12 08:44:25 CET
;; From 8.8.8.8@53(UDP) in 16.3 ms

### END 0 492302.03
### BEGIN server 492302.03 192.0.2.1
;; WARNING: response timeout for 192.0.2.1@53(UDP)
;; ERROR: failed to query server 192.0.2.1@53(UDP)

### END 1 492305.05
`;
export const COMPARE_NX = `### BEGIN server 492316.20 router
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 34432
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 0; AUTHORITY: 1; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; nonexistent-flab.example.com.		IN	A

;; AUTHORITY SECTION:
example.com.        	60	IN	SOA	elliott.ns.cloudflare.com. dns.cloudflare.com. 2418004112 10000 2400 604800 1800

;; Received 119 B
;; Time 2026-11-12 08:44:39 CET
;; From 127.0.0.1@53(UDP) in 11.8 ms

### END 0 492316.22
### BEGIN server 492316.22 1.1.1.1
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 49967
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 0; AUTHORITY: 1; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; nonexistent-flab.example.com.		IN	A

;; AUTHORITY SECTION:
example.com.        	1800	IN	SOA	elliott.ns.cloudflare.com. dns.cloudflare.com. 2418004112 10000 2400 604800 1800

;; Received 119 B
;; Time 2026-11-12 08:44:39 CET
;; From 1.1.1.1@53(UDP) in 6.7 ms

### END 0 492316.24
`;
export const CHECK_OK = `### BEGIN route4 492324.29 
default via 37.179.98.1 dev pppoe-wan proto static 

### END 0 492324.30
### BEGIN route6 492324.30 
default from 2a01:827:2443:6f00::/56 via fe80::b643:26ff:fed2:ad3d dev pppoe-wan proto static metric 512 pref medium
default from 2a01:827:5c44:436f::/64 via fe80::b643:26ff:fed2:ad3d dev pppoe-wan proto static metric 512 pref medium

### END 0 492324.30
### BEGIN gateway 492324.32 37.179.98.1 pppoe-wan
PING 37.179.98.1 (37.179.98.1): 56 data bytes
64 bytes from 37.179.98.1: seq=0 ttl=255 time=3.072 ms
64 bytes from 37.179.98.1: seq=1 ttl=255 time=5.005 ms

--- 37.179.98.1 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max = 3.072/4.038/5.005 ms

### END 0 492325.33
### BEGIN internet4 492325.33 1.1.1.1
PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: seq=0 ttl=58 time=15.784 ms
64 bytes from 1.1.1.1: seq=1 ttl=58 time=4.068 ms

--- 1.1.1.1 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max = 4.068/9.926/15.784 ms

### END 0 492326.34
### BEGIN internet4 492326.34 8.8.8.8
PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: seq=0 ttl=118 time=13.035 ms
64 bytes from 8.8.8.8: seq=1 ttl=118 time=12.845 ms

--- 8.8.8.8 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max = 12.845/12.940/13.035 ms

### END 0 492327.36
### BEGIN dns_router 492327.36 example.com
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 49632
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; example.com.        		IN	A

;; ANSWER SECTION:
example.com.        	232	IN	A	104.20.23.154
example.com.        	232	IN	A	172.66.147.243

;; Received 72 B
;; Time 2026-11-12 08:44:51 CET
;; From 127.0.0.1@53(UDP) in 0.4 ms

### END 0 492327.37
### BEGIN dns_public 492327.37 example.com
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 46442
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; example.com.        		IN	A

;; ANSWER SECTION:
example.com.        	232	IN	A	104.20.23.154
example.com.        	232	IN	A	172.66.147.243

;; Received 72 B
;; Time 2026-11-12 08:44:51 CET
;; From 1.1.1.1@53(UDP) in 5.8 ms

### END 0 492327.39
### BEGIN internet6 492327.39 2606:4700:4700::1111
PING 2606:4700:4700::1111 (2606:4700:4700::1111): 56 data bytes
64 bytes from 2606:4700:4700::1111: seq=0 ttl=58 time=5.496 ms
64 bytes from 2606:4700:4700::1111: seq=1 ttl=58 time=4.993 ms

--- 2606:4700:4700::1111 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max = 4.993/5.244/5.496 ms

### END 0 492328.40
### BEGIN dns6 492328.40 example.com
;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 25679
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; EDNS PSEUDOSECTION:
;; Version: 0; flags: ; UDP size: 1232 B; ext-rcode: NOERROR

;; QUESTION SECTION:
;; example.com.        		IN	AAAA

;; ANSWER SECTION:
example.com.        	238	IN	AAAA	2606:4700:10::ac42:93f3
example.com.        	238	IN	AAAA	2606:4700:10::6814:179a

;; Received 96 B
;; Time 2026-11-12 08:44:52 CET
;; From 127.0.0.1@53(UDP) in 0.3 ms

### END 0 492328.42
### BEGIN tls 492328.42 example.com
Connecting to 2606:4700:10::6814:179a
CONNECTED(00000003)
depth=3 C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
verify return:1
depth=2 C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
verify return:1
depth=1 C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
verify return:1
depth=0 CN=example.com
verify return:1
---
Certificate chain
 0 s:CN=example.com
   i:C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256
   v:NotBefore: Sep 26 22:49:11 2026 GMT; NotAfter: Dec 25 22:56:35 2026 GMT
 1 s:C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
   i:C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
   a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA384
   v:NotBefore: May 29 19:49:45 2025 GMT; NotAfter: May 27 19:49:44 2035 GMT
 2 s:C=US, O=SSL Corporation, CN=SSL.com TLS Transit ECC CA R2
   i:C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
   a:PKEY: EC, (secp384r1); sigalg: ecdsa-with-SHA384
   v:NotBefore: Oct 21 17:02:23 2022 GMT; NotAfter: Oct 17 17:02:22 2037 GMT
 3 s:C=US, O=SSL Corporation, CN=SSL.com TLS ECC Root CA 2022
   i:C=GB, ST=Greater Manchester, L=Salford, O=Comodo CA Limited, CN=AAA Certificate Services
   a:PKEY: EC, (secp384r1); sigalg: sha256WithRSAEncryption
   v:NotBefore: Aug  1 00:00:00 2025 GMT; NotAfter: Dec 31 23:59:59 2028 GMT
---
Server certificate
-----BEGIN CERTIFICATE-----
MIID5jCCA42gAwIBAgIQAe7mqrtSHV4U/DFf2ZhWkDAKBggqhkjOPQQDAjBRMQsw
CQYDVQQGEwJVUzEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMSgwJgYDVQQDDB9D
-----END CERTIFICATE-----
subject=CN=example.com
issuer=C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: ecdsa_secp256r1_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 5070 bytes and written 1624 bytes
Verification: OK
Verified peername: example.com
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 256 bit
This TLS version forbids renegotiation.
No ALPN negotiated
Early data was not sent
Verify return code: 0 (ok)
---
DONE

### END 0 492328.56
`;
