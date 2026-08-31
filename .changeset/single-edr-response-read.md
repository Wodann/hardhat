---
"hardhat": patch
---

Read an EDR response's `data` once instead of twice, which removes a redundant clone of the whole JSON-RPC payload from every request.
