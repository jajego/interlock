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
    readonly validate: (input: unknown) =>
      | { readonly value: Parsed; readonly issues?: undefined }
      | {
          readonly issues: readonly {
            message: string;
            path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
          }[];
        }
      | Promise<
          | { readonly value: Parsed; readonly issues?: undefined }
          | {
              readonly issues: readonly {
                message: string;
                path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
              }[];
            }
        >;
    readonly types?: { readonly input: Submitted; readonly output: Parsed };
  };
}

export type Schema<Submitted, Parsed> =
  InputSchema<Submitted, Parsed> | StandardSchema<Submitted, Parsed>;

export interface InternalDenial {
  code: string;
  publicMessage?: string;
  privateMessage?: string;
  details?: JsonValue;
}
export interface PublicDenial {
  source: "state" | "authorization" | "guard";
  rule?: string;
  code: string;
  publicMessage?: string;
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
  strategy:
    | "none"
    | "row-locking"
    | "aggregate-version"
    | "dependency-version"
    | "serializable"
    | "database-constraint"
    | "custom";
  notes: string;
};

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
  claimIdempotency(
    transaction: Transaction,
    claim: IdempotencyClaim,
  ): Promise<IdempotencyClaimResult>;
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
  insertTransition(
    transaction: Transaction,
    transition: TransitionRecord,
  ): Promise<void>;
  insertOutbox(
    transaction: Transaction,
    messages: readonly OutboxInsert[],
  ): Promise<void>;
}

export interface ResourceBinding<Transaction, Resource, Mutation, Context> {
  transactionOptions(args: {
    mode: AssessmentMode;
    event: string;
  }): TransactionOptions;
  loadPrimary(transaction: Transaction, id: string): Promise<Resource | null>;
  getId(resource: Resource): string;
  getState(resource: Resource): string;
  getVersion(resource: Resource): VersionToken;
  applyPrimary(
    transaction: Transaction,
    args: {
      resource: Resource;
      fromState: string;
      toState: string;
      expectedVersion: VersionToken;
      nextVersion: VersionToken;
      mutation: Mutation;
    },
  ): Promise<
    | { status: "applied"; resource: Resource }
    | { status: "conflict"; actual?: { state: string; version: VersionToken } }
    | { status: "not-found" }
  >;
  applyRelated?(
    transaction: Transaction,
    args: {
      previousResource: Resource;
      updatedResource: Resource;
      mutation: Mutation;
      transitionId: string;
      occurredAt: Date;
    },
  ): Promise<void>;
  hydrateBeforeCommit?(
    transaction: Transaction,
    resource: Resource,
  ): Promise<Resource>;
  contextFactory: {
    create(
      transaction: Transaction,
      options: { mode: AssessmentMode; event: string },
    ): Context;
  };
  consistency(event: string): RelatedDataConsistency;
}

export type TransitionResult<Resource> =
  | {
      status: "committed";
      duplicate: false;
      resource: Resource;
      transition: TransitionRecord;
    }
  | { status: "committed"; duplicate: true; transition: TransitionRecord }
  | {
      status: "denied";
      event: string;
      currentState: string;
      targetState?: string;
      reasons: readonly PublicDenial[];
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
      reasons: readonly PublicDenial[];
    }
  | { status: "not-found" }
  | { status: "unknown-event"; event: string }
  | { status: "invalid-input"; issues: readonly InputIssue[] };
