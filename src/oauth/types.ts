/** Minimal OAuth types, ported from jawcode packages/ai/src/utils/oauth/types.ts. */
export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number; // epoch ms (already skew-adjusted by the provider flow)
  email?: string;
  accountId?: string;
  providerMetadata?: OAuthProviderMetadata;
};

export interface KiroOAuthMetadata {
  source: "kiro-cli";
  authType: "social" | "oidc";
  /** Runtime region derived from the CodeWhisperer profile ARN. */
  region: string;
  /** OIDC refresh region may differ from the runtime region. */
  ssoRegion?: string;
  profileArn: string;
}

export interface OAuthProviderMetadata {
  kiro?: KiroOAuthMetadata;
}


export interface OAuthController {
  onAuth?(info: { url: string; instructions?: string; code?: string }): void;
  onProgress?(message: string): void;
  onManualCodeInput?(): Promise<string>;
  signal?: AbortSignal;
}

/**
 * How a login flow may use a locally detected CLI token.
 * "off" goes straight to the real OAuth flow, "fallback" imports a local token when present
 * and falls back to OAuth otherwise, "only" imports without any OAuth fallback.
 */
export type LocalTokenImportMode = "off" | "fallback" | "only";
