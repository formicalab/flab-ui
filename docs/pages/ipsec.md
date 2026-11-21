# IPsec VPN (route `#ipsec`)
One card per strongSwan connection: header with state and security grade, a router-to-gateway flow diagram,
IKE SA details, tunnel (child SA) details, live traffic with interface counters and a chart, and a 0-100 score
breakdown with warnings. Below the tiles come the daemon card, which is about the daemon rather than any one
connection, then the score explanation (IKE encryption 20, IKE PRF/integrity 10,
IKE key exchange 20, authentication 10, ESP encryption 20, PFS 15, rekeying and liveness 5) and the connection
cards. Compact/detailed toggle. When charon is not running, the daemon card is a red error if connections are
configured, and a plain note when `/etc/config/swanctl` has no sections (the init script then never starts charon);
the plugin reports this as `daemon.configured`.

- IKE may float to UDP/4500 while ESP stays native (no UDP encapsulation); these are reported separately.
- `xfrmN` interfaces are matched to child SAs by `if_id` (hex in VICI, decimal in uci `ifid`).
- Pre-shared-key authentication caps the authentication score at 6/10 and raises a warning, because key
  entropy cannot be observed.
- The page is rebuilt from the backend reply on every poll, so connections, rekeys and state changes show up
  without a reload. The backend lists every configured connection (DOWN when it has no SA) and every live IKE
  SA. A connection with several IKE SAs (`unique = no`) gets one card per SA (`instance` = IKE SA id, `key` =
  `name#id`). An SA whose connection is not in the loaded configuration, or a child SA whose child config is
  absent, is still shown and flagged `orphan`; its authentication and lifetime policy cannot be seen, so those
  score parts are neutral (`unknown`) instead of producing false pre-shared-key or lifetime advice. Global
  IPv6 addresses on an `xfrmN` interface are listed next to the IPv4 tunnel address; link-local ones are
  skipped.
