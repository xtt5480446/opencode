export class AuthError extends Error {}
export class CreditsError extends Error {}
export class MonthlyLimitError extends Error {}
export class UserLimitError extends Error {}
export class ModelError extends Error {}

class LimitError extends Error {
  retryAfter?: number
  constructor(message: string, retryAfter?: number) {
    super(message)
    this.retryAfter = retryAfter
  }
}
export class RateLimitError extends LimitError {}
export type FreeUsageLimitMetadata = {
  workspace?: string
  subscribedToGo?: boolean
  hasCredits?: boolean
}
export class FreeUsageLimitError extends LimitError {
  metadata: FreeUsageLimitMetadata
  constructor(message: string, retryAfter?: number, metadata: FreeUsageLimitMetadata = {}) {
    super(message, retryAfter)
    this.metadata = metadata
  }
}
export class BlackUsageLimitError extends LimitError {}

type LimitName = "5 hour" | "weekly" | "monthly"
export class GoUsageLimitError extends LimitError {
  workspace: string
  limitName: LimitName
  constructor(message: string, workspace: string, limitName: LimitName, retryAfter?: number) {
    super(message, retryAfter)
    this.workspace = workspace
    this.limitName = limitName
  }
}
