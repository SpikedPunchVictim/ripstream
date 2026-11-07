export interface Initializable {
  initialize(): Promise<void> | void;
}

export interface SelfConfiguring {
  configure(options: Readonly<Record<string, unknown>>): void;
}

export interface RipstreamPlugin {
  readonly name: string;
}

export class PluginRegistry {
  readonly #plugins = new Map<string, RipstreamPlugin>();
  readonly #initialized = new Set<string>();

  register(plugin: RipstreamPlugin): void {
    if (plugin.name.trim().length === 0) {
      throw new Error("Plugin name is required");
    }
    if (this.#plugins.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }
    this.#plugins.set(plugin.name, plugin);
  }

  get(name: string): RipstreamPlugin | undefined {
    return this.#plugins.get(name);
  }

  list(): readonly RipstreamPlugin[] {
    return [...this.#plugins.values()];
  }

  async initializeAll(
    options: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    for (const plugin of this.#plugins.values()) {
      if (this.#initialized.has(plugin.name)) continue;
      if ("configure" in plugin) {
        (plugin as SelfConfiguring).configure(
          (options[plugin.name] ?? {}) as Record<string, unknown>,
        );
      }
      if ("initialize" in plugin) {
        await (plugin as Initializable).initialize();
      }
      this.#initialized.add(plugin.name);
    }
  }
}

/** Loads a module and registers its default export (or named plugin). */
export async function loadPlugin(
  moduleUrl: string | URL,
  registry: PluginRegistry,
  exportName = "default",
): Promise<RipstreamPlugin> {
  const module = (await import(
    moduleUrl instanceof URL ? moduleUrl.href : moduleUrl
  )) as Record<string, unknown>;
  const plugin = module[exportName];
  if (
    typeof plugin !== "object" ||
    plugin === null ||
    typeof (plugin as RipstreamPlugin).name !== "string"
  ) {
    throw new Error(`Plugin export ${exportName} is invalid`);
  }
  registry.register(plugin as RipstreamPlugin);
  return plugin as RipstreamPlugin;
}
