import { cosmiconfig } from 'cosmiconfig';

import type { Config } from './schema.ts';
import {
  cliFlagsSchema,
  configSchema,
  configSources,
  envSchema,
  fileConfigSchema,
} from './schema.ts';

const explorer = cosmiconfig('heimdall');

const hasOwn = (source: Record<string, unknown>, key: string): boolean => {
  return Object.prototype.hasOwnProperty.call(source, key);
};

export const loadConfig = async (flagsInput: unknown, cwd: string): Promise<Config> => {
  const flags = cliFlagsSchema.parse(flagsInput);
  const env = envSchema.parse(process.env);
  const result = flags.config ? await explorer.load(flags.config) : await explorer.search(cwd);
  const file = fileConfigSchema.parse(result?.config ?? {});
  const config: Record<string, unknown> = {};

  for (const key of Object.keys(configSources) as (keyof Config)[]) {
    const source = configSources[key];
    config[key] = source.defaultValue;

    if (source.file !== undefined && hasOwn(file, source.file.key)) {
      config[key] = file[source.file.key];
    }

    if (source.env !== undefined && hasOwn(env, source.env.key)) {
      config[key] = env[source.env.key];
    }

    for (const flag of source.flags ?? []) {
      const value = flag.resolve(flags[flag.key]);

      if (value !== undefined) {
        config[key] = value;
      }
    }
  }

  return configSchema.parse(config);
};
