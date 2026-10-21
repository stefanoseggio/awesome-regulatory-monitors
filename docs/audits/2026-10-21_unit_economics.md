# Unit economics per run

Break-even run time = net revenue / (memory GB x compute rate per GB-hour). Net revenue = (1 - marketplace margin) x (start events x start price + rows x event price), watchlist hits excluded (they are the operator-stated, upside-only event).
Compute rates are a SENSITIVITY INPUT (USD per GB-hour): 0.20, 0.25, 0.30, 0.40. Replace them with the account's plan rate; no run time here is measured.

## global-regtech-compliance-feed

Memory 2048 MB, 2 start event(s) at 0.005000, marketplace margin 20 percent.

| Scenario | Net revenue (USD) | Break-even at 0.20/GB-h | Break-even at 0.25/GB-h | Break-even at 0.30/GB-h | Break-even at 0.40/GB-h |
| --- | ---: | ---: | ---: | ---: | ---: |
| empty run | 0.008000 | 72 s | 57 s | 48 s | 36 s |
| 10 rows at vessel-record (0.000500) | 0.012000 | 108 s | 86 s | 72 s | 54 s |
| 10 rows at enforcement-release (0.050000) | 0.408000 | 3672 s | 2937 s | 2448 s | 1836 s |
| 100 rows at vessel-record (0.000500) | 0.048000 | 432 s | 345 s | 288 s | 216 s |
| 100 rows at enforcement-release (0.050000) | 4.008000 | 36072 s | 28857 s | 24048 s | 18036 s |
| 1000 rows at vessel-record (0.000500) | 0.408000 | 3672 s | 2937 s | 2448 s | 1836 s |
| 1000 rows at enforcement-release (0.050000) | 40.008000 | 360072 s | 288057 s | 240048 s | 180036 s |

## latam-global-tender-intelligence

Memory 1024 MB, 1 start event(s) at 0.005000, marketplace margin 20 percent.

| Scenario | Net revenue (USD) | Break-even at 0.20/GB-h | Break-even at 0.25/GB-h | Break-even at 0.30/GB-h | Break-even at 0.40/GB-h |
| --- | ---: | ---: | ---: | ---: | ---: |
| empty run | 0.004000 | 72 s | 57 s | 48 s | 36 s |
| 10 rows at tender-summary (0.001000) | 0.012000 | 216 s | 172 s | 144 s | 108 s |
| 10 rows at notice-new (0.020000) | 0.164000 | 2952 s | 2361 s | 1968 s | 1476 s |
| 100 rows at tender-summary (0.001000) | 0.084000 | 1512 s | 1209 s | 1008 s | 756 s |
| 100 rows at notice-new (0.020000) | 1.604000 | 28872 s | 23097 s | 19248 s | 14436 s |
| 1000 rows at tender-summary (0.001000) | 0.804000 | 14472 s | 11577 s | 9648 s | 7236 s |
| 1000 rows at notice-new (0.020000) | 16.004000 | 288072 s | 230457 s | 192048 s | 144036 s |

## global-corporate-patent-intelligence

Memory 1024 MB, 1 start event(s) at 0.005000, marketplace margin 20 percent.

| Scenario | Net revenue (USD) | Break-even at 0.20/GB-h | Break-even at 0.25/GB-h | Break-even at 0.30/GB-h | Break-even at 0.40/GB-h |
| --- | ---: | ---: | ---: | ---: | ---: |
| empty run | 0.004000 | 72 s | 57 s | 48 s | 36 s |
| 10 rows at patent-proceeding (0.002000) | 0.020000 | 360 s | 288 s | 240 s | 180 s |
| 10 rows at sg-entity-new (0.030000) | 0.244000 | 4392 s | 3513 s | 2928 s | 2196 s |
| 100 rows at patent-proceeding (0.002000) | 0.164000 | 2952 s | 2361 s | 1968 s | 1476 s |
| 100 rows at sg-entity-new (0.030000) | 2.404000 | 43272 s | 34617 s | 28848 s | 21636 s |
| 1000 rows at patent-proceeding (0.002000) | 1.604000 | 28872 s | 23097 s | 19248 s | 14436 s |
| 1000 rows at sg-entity-new (0.030000) | 24.004000 | 432072 s | 345657 s | 288048 s | 216036 s |

