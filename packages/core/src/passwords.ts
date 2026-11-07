export interface PasswordProvider {
  getPassword(): string | null | undefined;
}

export class StaticPasswordProvider implements PasswordProvider {
  readonly #password: string;

  constructor(password: string) {
    this.#password = password;
  }

  getPassword(): string {
    return this.#password;
  }
}

/** Tries the empty password first, matching Ripstream's default attempt. */
export class EmptyPasswordProvider implements PasswordProvider {
  getPassword(): string {
    return "";
  }
}

export class CompositePasswordProvider implements PasswordProvider {
  readonly #providers: readonly PasswordProvider[];

  constructor(providers: readonly PasswordProvider[]) {
    this.#providers = providers;
  }

  getPassword(): string | null {
    for (const provider of this.#providers) {
      const password = provider.getPassword();
      if (password !== null && password !== undefined) return password;
    }
    return null;
  }
}
