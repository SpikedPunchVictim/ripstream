import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AwsCredentials } from "./sigv4.ts";

/*
 * Where an S3 component gets its credentials, by Tika's `credentialsProvider`: `key_secret` (the settings' own keys),
 * `profile` (a named profile of the AWS shared credentials and config files) and `instance` (the EC2 instance metadata
 * service, IMDSv2). Anything else the AWS SDK's default chain does (environment variables, web identity, SSO,
 * `role_arn`, `credential_process`) is not read, as Tika's components do not name those either.
 */

export type CredentialProvider = () => Promise<AwsCredentials>;

export function staticCredentials(accessKeyId: string, secretAccessKey: string): CredentialProvider {
  const credentials = { accessKeyId, secretAccessKey };
  return async () => credentials;
}

type Sections = Map<string, Map<string, string>>;

/** The sections of an AWS shared file: `[name]` headings, `key = value` lines, `#` and `;` comments. */
export function parseAwsIni(text: string, configFile: boolean): Sections {
  const sections: Sections = new Map();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = /^\[(.+)\]$/.exec(line);
    if (heading !== null) {
      // The config file names a profile `[profile x]` (and `[default]`); the credentials file just `[x]`.
      const name = (heading[1] ?? "").trim();
      const profile = configFile ? (name.startsWith("profile ") ? name.slice("profile ".length).trim() : name === "default" ? name : null) : name;
      current = profile === null ? undefined : (sections.get(profile) ?? sections.set(profile, new Map()).get(profile));
      continue;
    }
    const at = line.indexOf("=");
    if (current !== undefined && at > 0) current.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return sections;
}

export interface ProfileOptions {
  /** Where the files are, by the AWS SDK's own variables. Default `~/.aws/credentials` and `~/.aws/config`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

/** A profile of the shared files. Read on each call, so a rotated key is picked up, as the SDK's provider does. */
export function profileCredentials(profile: string, options: ProfileOptions = {}): CredentialProvider {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const credentialsFile = env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, ".aws", "credentials");
  const configFile = env.AWS_CONFIG_FILE ?? join(home, ".aws", "config");
  const read = (path: string): Promise<string> =>
    readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  return async () => {
    const [fromCredentials, fromConfig] = await Promise.all([read(credentialsFile), read(configFile)]);
    // The credentials file wins over the config file, as in the SDK.
    const entries = new Map<string, string>([
      ...(parseAwsIni(fromConfig, true).get(profile) ?? []),
      ...(parseAwsIni(fromCredentials, false).get(profile) ?? []),
    ]);
    const accessKeyId = entries.get("aws_access_key_id");
    const secretAccessKey = entries.get("aws_secret_access_key");
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      const others = ["role_arn", "sso_session", "sso_start_url", "credential_process", "web_identity_token_file"].filter((key) => entries.has(key));
      throw new Error(
        others.length > 0
          ? `AWS profile ${JSON.stringify(profile)} uses ${others.join(", ")}, which ripstream does not read: give it aws_access_key_id and aws_secret_access_key`
          : `AWS profile ${JSON.stringify(profile)} has no aws_access_key_id and aws_secret_access_key in ${credentialsFile} or ${configFile}`,
      );
    }
    const sessionToken = entries.get("aws_session_token");
    return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) };
  };
}

export interface InstanceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /** Default `AWS_EC2_METADATA_SERVICE_ENDPOINT`, else `http://169.254.169.254`. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/** How long before it expires a role's credentials are replaced. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

/**
 * The credentials of the instance's role, from the metadata service (IMDSv2: a token first). They are kept until five
 * minutes before they expire, and a refresh in progress is shared by every caller. Not run against a real instance.
 */
export function instanceCredentials(options: InstanceOptions = {}): CredentialProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = (options.endpoint ?? process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT ?? "http://169.254.169.254").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 2_000;
  let cached: { credentials: AwsCredentials; expires: number } | undefined;
  let refreshing: Promise<AwsCredentials> | undefined;

  const call = async (path: string, init: RequestInit): Promise<string> => {
    const response = await doFetch(`${endpoint}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) throw new Error(`the instance metadata service answered ${response.status} for ${path}`);
    return response.text();
  };

  const load = async (): Promise<AwsCredentials> => {
    const token = await call("/latest/api/token", { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" } });
    const headers = { "x-aws-ec2-metadata-token": token };
    const role = (await call("/latest/meta-data/iam/security-credentials/", { headers })).split("\n")[0]?.trim();
    if (role === undefined || role === "") throw new Error("the instance has no IAM role: the metadata service lists none");
    const body = JSON.parse(await call(`/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers })) as Record<string, unknown>;
    if (typeof body.AccessKeyId !== "string" || typeof body.SecretAccessKey !== "string" || typeof body.Token !== "string") {
      throw new Error(`the instance metadata service gave no credentials for role ${role}`);
    }
    const expires = typeof body.Expiration === "string" ? Date.parse(body.Expiration) : Number.NaN;
    const credentials = { accessKeyId: body.AccessKeyId, secretAccessKey: body.SecretAccessKey, sessionToken: body.Token };
    cached = { credentials, expires: Number.isNaN(expires) ? now().getTime() : expires };
    return credentials;
  };

  return async () => {
    if (cached !== undefined && now().getTime() < cached.expires - REFRESH_BEFORE_EXPIRY_MS) return cached.credentials;
    refreshing ??= load().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
}
