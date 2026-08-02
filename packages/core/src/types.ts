export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type VersionToken = string & { readonly __brand: "VersionToken" };
export type VersionExpectation = VersionToken | "use-loaded-version";
export interface InputIssue {
  path: readonly (string | number)[];
  code: string;
  message: string;
}

export type ParseResult<Value> =
  | { success: true; value: Value }
  | { success: false; issues: readonly InputIssue[] };

export interface InputSchema<Submitted, Parsed> {
  readonly types?: {
    readonly submitted: Submitted;
    readonly parsed: Parsed;
  };
  parse(input: unknown): ParseResult<Parsed> | Promise<ParseResult<Parsed>>;
}

export interface StandardSchema<Submitted, Parsed> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor?: string | undefined;
    readonly validate: (
      input: unknown,
      options?: {
        readonly libraryOptions?: Record<string, unknown> | undefined;
      },
    ) =>
      | { readonly value: Parsed; readonly issues?: undefined }
      | {
          readonly issues: readonly {
            message: string;
            path?:
              | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
              | undefined;
          }[];
        }
      | Promise<
          | { readonly value: Parsed; readonly issues?: undefined }
          | {
              readonly issues: readonly {
                message: string;
                path?:
                  | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
                  | undefined;
              }[];
            }
        >;
    readonly types?:
      { readonly input: Submitted; readonly output: Parsed } | undefined;
  };
}

export type Schema<Submitted, Parsed> =
  InputSchema<Submitted, Parsed> | StandardSchema<Submitted, Parsed>;

export interface InternalDenial {
  code: string;
  message?: string;
  publicDetails?: JsonValue;
  privateMessage?: string;
  privateDetails?: JsonValue;
}
export interface PublicDenial {
  source: "state" | "authorization" | "guard";
  rule?: string;
  code: string;
  message?: string;
  publicDetails?: JsonValue;
}
export type Decision =
  boolean | { allowed: true } | { allowed: false; denial: InternalDenial };
export const allow = (): Decision => ({ allowed: true });
export const deny = (denial: InternalDenial): Decision => ({
  allowed: false,
  denial,
});

export type AssessmentMode = "advisory" | "authoritative";
export interface TransactionOptions {
  isolation?: "read-committed" | "repeatable-read" | "serializable";
  readOnly?: boolean;
}
export type RelatedDataConsistency = {
  /** Mechanism that stabilizes related facts consulted by policy checks. */
  strategy:
    | "none"
    | "row-locking"
    | "aggregate-version"
    | "dependency-version"
    | "serializable"
    | "database-constraint"
    | "custom";
  /** Concrete application-specific explanation of the mechanism. */
  notes: string;
};

/** Declares that policy depends only on the version-checked primary row. */
export const primaryRowOnly = Object.freeze({
  strategy: "none",
  notes: "This event depends only on the primary resource row.",
} as const satisfies RelatedDataConsistency);

/** Immutable command identity shared by lifecycle and persistence callbacks. */
export interface InterlockOperation<Actor, Event extends string = string> {
  readonly mode: AssessmentMode;
  readonly id: string;
  readonly event: Event;
  readonly actor: Actor;
  readonly metadata?: JsonValue;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export type WriteOperation<Actor, Mutations extends Record<string, unknown>> = {
  [Event in Extract<keyof Mutations, string>]: InterlockOperation<
    Actor,
    Event
  > & { readonly mutation: Mutations[Event] };
}[Extract<keyof Mutations, string>];

export interface TransitionRecord {
  id: string;
  lifecycle: string;
  resourceType: string;
  resourceId: string;
  event: string;
  fromState: string;
  toState: string;
  previousVersion: VersionToken;
  nextVersion: VersionToken;
  actorType?: string;
  actorId?: string;
  auditData?: JsonValue;
  metadata?: JsonValue;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  definitionVersion?: string;
  occurredAt: Date;
}
export interface OutboxInsert {
  id: string;
  lifecycle: string;
  resourceType: string;
  resourceId: string;
  transitionId: string;
  topic: string;
  key?: string;
  payload: JsonValue;
  createdAt: Date;
}
export interface IdempotencyClaim {
  lifecycle: string;
  resourceId: string;
  key: string;
  fingerprint: string;
  createdAt: Date;
}
export type IdempotencyClaimResult =
  | { status: "claimed" }
  | { status: "conflict" }
  | { status: "duplicate"; transition: TransitionRecord };

export interface TransactionDriver<Transaction> {
  /**
   * Rolls back for every thrown value. Values used for caller-controlled
   * rollback must be rethrown unchanged; operational failures must be exposed
   * as InterlockError instances.
   */
  transaction<Result>(
    operation: (transaction: Transaction) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;
  /** Claims a key or returns conflict/stored duplicate history in this transaction. */
  claimIdempotency(
    transaction: Transaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult>;
  /** Links the successful claim to inserted history before commit. */
  completeIdempotency(
    transaction: Transaction,
    completion: {
      lifecycle: string;
      resourceId: string;
      key: string;
      transitionId: string;
      completedAt: Date;
    },
  ): Promise<void>;
  /** Inserts the immutable transition record; no success value is expected. */
  insertTransition(
    transaction: Transaction,
    transition: TransitionRecord,
  ): Promise<void>;
  /** Inserts all planned outbox records atomically; batching is driver-owned. */
  insertOutbox(
    transaction: Transaction,
    messages: readonly OutboxInsert[],
  ): Promise<void>;
}

interface ResourceBindingBase<
  Transaction,
  Resource,
  Actor,
  Mutations extends Record<string, unknown>,
> {
  /** Chooses transaction options before opening the operation transaction. */
  transactionOptions?(
    operation: InterlockOperation<Actor, Extract<keyof Mutations, string>>,
  ): TransactionOptions;
  /** Loads the primary resource using the scoped transaction and operation identity. */
  loadPrimary(
    transaction: Transaction,
    operation: InterlockOperation<Actor, Extract<keyof Mutations, string>>,
  ): Promise<Resource | null>;
  /** Extracts the globally unique lifecycle resource ID for validation. */
  getId(resource: Resource): string;
  /** Extracts the current lifecycle state for source-state validation. */
  getState(resource: Resource): string;
  /** Extracts a positive BIGINT string; Interlock brands it internally. */
  getVersion(resource: Resource): string;
  /**
   * Performs the state-and-version compare-and-swap. `applied` must return the
   * requested ID, target state, and next version; conflicts may include a
   * validated current state/version snapshot.
   */
  applyPrimary(
    transaction: Transaction,
    args: {
      resource: Resource;
      fromState: string;
      toState: string;
      expectedVersion: VersionToken;
      nextVersion: VersionToken;
      operation: WriteOperation<Actor, Mutations>;
    },
  ): Promise<
    | { status: "applied"; resource: Resource }
    | { status: "conflict"; actual?: { state: string; version: string } }
    | { status: "not-found" }
  >;
  /**
   * Optionally writes related application rows after history insertion and
   * before outbox insertion. Work extends the same transaction and lock time.
   */
  applyRelated?(
    transaction: Transaction,
    args: {
      previousResource: Resource;
      updatedResource: Resource;
      operation: WriteOperation<Actor, Mutations>;
      readonly transitionId: string;
      occurredAt: Date;
    },
  ): Promise<void>;
  /**
   * Optionally reloads the committed-shape resource before commit. This adds
   * transaction duration and must preserve ID, target state, and next version.
   */
  hydrateBeforeCommit?(
    transaction: Transaction,
    args: {
      resource: Resource;
      operation: WriteOperation<Actor, Mutations>;
    },
  ): Promise<Resource>;
  /** Declares how related facts used by this binding remain consistent. */
  consistency:
    | RelatedDataConsistency
    | ((event: Extract<keyof Mutations, string>) => RelatedDataConsistency);
}

type ContextBinding<Transaction, Actor, Context, Event extends string> = [
  Context,
] extends [undefined | void]
  ? {
      contextFactory?: {
        /** Creates request-scoped read helpers on the operation transaction. */
        create(
          transaction: Transaction,
          operation: InterlockOperation<Actor, Event>,
        ): Context | PromiseLike<Context>;
      };
    }
  : {
      contextFactory: {
        /** Creates required request-scoped context on the operation transaction. */
        create(
          transaction: Transaction,
          operation: InterlockOperation<Actor, Event>,
        ): Context | PromiseLike<Context>;
      };
    };

/** Maps one application resource and its writes onto a driver transaction. */
export type ResourceBinding<
  Transaction,
  Resource,
  Actor,
  Context,
  Mutations extends Record<string, unknown>,
> = ResourceBindingBase<Transaction, Resource, Actor, Mutations> &
  ContextBinding<Transaction, Actor, Context, Extract<keyof Mutations, string>>;

/** Expected authoritative command outcome; operational failures throw. */
export type TransitionResult<Resource> =
  | {
      /** A newly executed command committed with its validated resource. */
      status: "committed";
      duplicate: false;
      resource: Resource;
      transition: TransitionRecord;
    }
  | {
      /** Stored history for a committed duplicate; current resource is not loaded. */
      status: "committed";
      duplicate: true;
      transition: TransitionRecord;
    }
  | {
      status: "denied";
      event: string;
      currentState: string;
      targetState?: string;
      reason: PublicDenial;
    }
  | {
      status: "conflict";
      expected: VersionExpectation;
      actual?: { state: string; version: VersionToken };
    }
  | { status: "not-found" }
  | { status: "unknown-event"; event: string }
  | { status: "invalid-input"; issues: readonly InputIssue[] }
  | { status: "idempotency-conflict"; key: string };

/** Expected advisory assessment outcome. */
export type AssessmentResult =
  | {
      status: "allowed";
      currentState: string;
      targetState: string;
    }
  | {
      status: "denied";
      event: string;
      currentState: string;
      targetState?: string;
      reason: PublicDenial;
    }
  | { status: "not-found" }
  | { status: "unknown-event"; event: string }
  | { status: "invalid-input"; issues: readonly InputIssue[] };
