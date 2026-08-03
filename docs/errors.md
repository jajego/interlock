# Error codes

Expected command outcomes are returned as results. `InterlockError` represents
an operational failure or a broken integration contract.

| Code                                      | Meaning and response                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `INTERLOCK_DEFINITION_INVALID`            | Lifecycle or client configuration is invalid. Fix before retrying.                          |
| `INTERLOCK_DEFINITION_PROTOCOL_VIOLATION` | A lifecycle callback returned an invalid value or failed. Fix the callback.                 |
| `INTERLOCK_BINDING_PROTOCOL_VIOLATION`    | A binding returned invalid data or violated a postcondition. Fix the binding.               |
| `INTERLOCK_DRIVER_PROTOCOL_VIOLATION`     | A transaction driver violated the persistence contract. Fix the driver.                     |
| `INTERLOCK_DRIVER_UNSUPPORTED`            | The requested transaction behavior is unsupported. Change the options.                      |
| `INTERLOCK_SERIALIZATION_FAILED`          | Command or projected JSON could not be serialized safely. Fix the value.                    |
| `INTERLOCK_PERSISTENCE_FAILED`            | An application or idempotency database operation failed. Inspect `cause`.                   |
| `INTERLOCK_HISTORY_FAILED`                | Transition-history insertion failed. Inspect `cause`.                                       |
| `INTERLOCK_OUTBOX_FAILED`                 | Outbox insertion failed. Inspect `cause`.                                                   |
| `INTERLOCK_SERIALIZATION_CONFLICT`        | PostgreSQL serialization failure. Retry the whole command with backoff.                     |
| `INTERLOCK_DEADLOCK`                      | PostgreSQL deadlock. Retry the whole command with backoff.                                  |
| `INTERLOCK_LOCK_TIMEOUT`                  | PostgreSQL lock timeout. Retry only if application policy permits.                          |
| `INTERLOCK_CANCELLED`                     | PostgreSQL cancelled the operation. Propagate cancellation or retry deliberately.           |
| `INTERLOCK_TRANSACTION_FAILED`            | An unclassified transaction failure occurred. Inspect `cause`; do not retry blindly.        |
| `INTERLOCK_COMMIT_OUTCOME_UNKNOWN`        | The connection failed during commit. Reconcile through idempotency/history before retrying. |
| `INTERLOCK_VERSION_EXHAUSTED`             | The resource reached PostgreSQL `BIGINT` capacity. Operational intervention is required.    |

Use `isInterlockError(error)` and switch on `error.code`. Only retry errors that
the table explicitly identifies as retryable, and always retry the complete
command rather than an individual write.

When configured, `InterlockObserver` reports thrown failures as
`interlock.operation.failed` with the same stable code, a protocol phase, and a
`not-started`, `not-committed`, or `unknown` commit outcome. The observation
never includes the error, message, cause, stack, SQL, or connection data. Log
the separately thrown error only under the application's security policy. See
the [observability guide](guides/observability.md).
