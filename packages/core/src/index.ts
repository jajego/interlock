export {
  InterlockError,
  isInterlockError,
  type InterlockErrorCode,
} from "./errors.js";
export {
  createInterlock,
  type BindingFor,
  type ClientFor,
  type InterlockClient,
} from "./executor.js";
export {
  type InterlockObservation,
  type InterlockObserver,
} from "./observer.js";
export {
  type AssessmentRequestFor,
  type TransitionRequestFor,
} from "./request.js";
export { assertJsonValue, canonicalHash, canonicalJson } from "./json.js";
export {
  defineLifecycle,
  defineEvent,
  noInput,
  type AssessmentArgs,
  type EventDefinition,
  type EventBuilder,
  type FingerprintArgs,
  type GuardDefinition,
  type IdempotencyConfiguration,
  type LifecycleDefinition,
  type Lifecycle,
  type MutationMap,
  type ProjectionArgs,
} from "./lifecycle.js";
export {
  allow,
  deny,
  primaryRowOnly,
  type AssessmentMode,
  type AssessmentResult,
  type Decision,
  type IdempotencyClaim,
  type IdempotencyClaimResult,
  type InputIssue,
  type InputSchema,
  type InterlockOperation,
  type InternalDenial,
  type JsonPrimitive,
  type JsonValue,
  type OutboxInsert,
  type ParseResult,
  type PublicDenial,
  type RelatedDataConsistency,
  type ResourceBinding,
  type Schema,
  type StandardSchema,
  type TransactionDriver,
  type TransactionOptions,
  type TransitionRecord,
  type TransitionResult,
  type VersionExpectation,
  type VersionToken,
  type WriteOperation,
} from "./types.js";
export {
  incrementVersion,
  MAX_BIGINT_VERSION,
  parseVersionToken,
} from "./version.js";
