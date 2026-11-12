// The output of busybox ping and traceroute and of the DNS tools as the routers printed it (captured 2026-11-12 on the
// GL-MT6000), shared by the Toolbox unit test and the browser test so both pin the same formats.

export const PING_OK = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: seq=0 ttl=58 time=4.309 ms
64 bytes from 1.1.1.1: seq=1 ttl=58 time=3.782 ms
64 bytes from 1.1.1.1: seq=2 ttl=58 time=4.434 ms
64 bytes from 1.1.1.1: seq=3 ttl=58 time=4.131 ms

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 4 packets received, 0% packet loss
round-trip min/avg/max = 3.782/4.164/4.434 ms
`;
export const PING_DOWN = `PING 192.0.2.77 (192.0.2.77): 56 data bytes

--- 192.0.2.77 ping statistics ---
3 packets transmitted, 0 packets received, 100% packet loss
`;
export const PING_V6 = `PING 2606:4700:4700::1111 (2606:4700:4700::1111): 56 data bytes
64 bytes from 2606:4700:4700::1111: seq=0 ttl=58 time=4.685 ms
64 bytes from 2606:4700:4700::1111: seq=1 ttl=58 time=4.501 ms

--- 2606:4700:4700::1111 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max = 4.501/4.593/4.685 ms
`;
// Four pings sent, the second lost (nothing is printed for it).
export const PING_LOSSY = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: seq=0 ttl=58 time=4.309 ms
64 bytes from 1.1.1.1: seq=2 ttl=58 time=4.434 ms
64 bytes from 1.1.1.1: seq=3 ttl=58 time=4.131 ms

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 3 packets received, 25% packet loss
round-trip min/avg/max = 4.131/4.291/4.434 ms
`;
export const PING_BAD = "ping: bad address 'no-such-host.invalid'\n";
export const TRACE = `traceroute to 1.1.1.1 (1.1.1.1), 8 hops max, 46 byte packets
 1  37.179.98.1  4.895 ms  3.445 ms
 2  *  *
 3  *  *
 4  185.210.48.76  6.922 ms  5.943 ms
 5  185.210.48.77  4.708 ms  6.619 ms
 6  172.68.196.21  5.287 ms  5.648 ms
 7  1.1.1.1  5.658 ms  6.154 ms
`;
export const TRACE6 = `traceroute to 2606:4700:4700::1111 (2606:4700:4700::1111), 5 hops max, 72 byte packets
 1  2a01:827:e000::c:3:11  12.147 ms  4.531 ms
 2  fd00::50:0  9.233 ms  5.136 ms
 3  2a01:8d0:80e:8301:1::a  5.034 ms  3.788 ms
 4  2a01:8d0:90e:a:1::a  27.092 ms  2001:7f8:10::3:722  5.363 ms
 5  2a01:8d0:90e:a:1::b  5.479 ms  *
`;
export const NSLOOKUP = `Server:\t\t127.0.0.1
Address:\t127.0.0.1:53

Non-authoritative answer:
Name:\texample.com
Address: 2606:4700:10::ac42:93f3
Name:\texample.com
Address: 2606:4700:10::6814:179a

Non-authoritative answer:
Name:\texample.com
Address: 172.66.147.243
Name:\texample.com
Address: 104.20.23.154
`;
export const NSLOOKUP_NX = `Server:\t\t127.0.0.1
Address:\t127.0.0.1:53

** server can't find no-such-host.invalid: NXDOMAIN

** server can't find no-such-host.invalid: NXDOMAIN
`;
export const NSLOOKUP_PTR = `Server:\t\t127.0.0.1
Address:\t127.0.0.1:53

Non-authoritative answer:
1.1.1.1.in-addr.arpa\tname = one.one.one.one
`;
export const KDIG = `;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 55442
;; Flags: qr rd ra ad; QUERY: 1; ANSWER: 2; AUTHORITY: 0; ADDITIONAL: 1

;; QUESTION SECTION:
;; example.com.        \t\tIN\tA

;; ANSWER SECTION:
example.com.        \t178\tIN\tA\t104.20.23.154
example.com.        \t178\tIN\tA\t172.66.147.243

;; Received 72 B
;; From 127.0.0.1@53(UDP) in 0.4 ms
`;
export const KDIG_NX = `;; ->>HEADER<<- opcode: QUERY; status: NXDOMAIN; id: 1
;; Flags: qr rd ra; QUERY: 1; ANSWER: 0; AUTHORITY: 1; ADDITIONAL: 1

;; From 127.0.0.1@53(UDP) in 0.4 ms
`;
export const DRILL = `;; ->>HEADER<<- opcode: QUERY, rcode: NOERROR, id: 8239
;; flags: qr rd ra ; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 0 
;; ANSWER SECTION:
example.com.\t178\tIN\tA\t172.66.147.243
example.com.\t178\tIN\tA\t104.20.23.154

;; SERVER: 127.0.0.1
`;
// The same traces with `traceroute` asked to look names up: "name (address)", and "address (address)" for a router that
// has no reverse record (no name). A silent probe can come first in a hop.
export const TRACE_NAMES = `traceroute to 1.1.1.1 (1.1.1.1), 8 hops max, 46 byte packets
 1  net-37-179-98-1.cust.vodafonedsl.it (37.179.98.1)  5.498 ms  15.551 ms
 2  *  *
 3  *  *
 4  185.210.48.76 (185.210.48.76)  7.362 ms  5.727 ms
 5  *  185.210.48.77 (185.210.48.77)  5.402 ms
 6  172.68.196.21 (172.68.196.21)  4.733 ms  7.240 ms
 7  one.one.one.one (1.1.1.1)  5.151 ms  4.405 ms
`;
export const TRACE6_NAMES = `traceroute to 2606:4700:4700::1111 (2606:4700:4700::1111), 5 hops max, 72 byte packets
 1  2a01:827:e000::c:3:11 (2a01:827:e000::c:3:11)  5.103 ms  5.039 ms
 2  fd00::50:0 (fd00::50:0)  4.090 ms  5.994 ms
 3  2a01:8d0:80e:8301:1::a (2a01:8d0:80e:8301:1::a)  4.820 ms  4.656 ms
 4  vodafone.rom.namex.it (2001:7f8:10::3:722)  4.987 ms  6.012 ms
 5  cloudflare.rom.namex.it (2001:7f8:10::1:3335)  28.521 ms  4.455 ms
`;
