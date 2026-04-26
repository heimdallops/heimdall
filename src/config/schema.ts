import { z } from 'zod';

export const configSchema = z
  .object({
    json: z.boolean().default(false),
    verbose: z.boolean().default(false),
    debug: z.boolean().default(false),
  })
  .strict();

export const cliFlagsSchema = z
  .object({
    json: z.boolean().optional(),
    verbose: z.boolean().optional(),
    debug: z.boolean().optional(),
    config: z.string().optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type CliFlags = z.infer<typeof cliFlagsSchema>;

interface ConfigSource<Key extends keyof Config> {
  readonly defaultValue: Config[Key];
  readonly file?: {
    readonly key: string;
    readonly schema: z.ZodType<Config[Key]>;
  };
  readonly env?: {
    readonly key: string;
    readonly schema: z.ZodType<Config[Key]>;
  };
  readonly flags?: readonly {
    readonly key: keyof CliFlags;
    readonly resolve: (value: CliFlags[keyof CliFlags]) => Config[Key] | undefined;
  }[];
}

type ConfigSources = {
  readonly [Key in keyof Config]: ConfigSource<Key>;
};

const booleanFlag = (value: CliFlags[keyof CliFlags]): boolean | undefined => {
  return typeof value === 'boolean' ? value : undefined;
};

export const configSources: ConfigSources = {
  json: {
    defaultValue: false,
    flags: [{ key: 'json', resolve: booleanFlag }],
  },
  verbose: {
    defaultValue: false,
    flags: [{ key: 'verbose', resolve: booleanFlag }],
  },
  debug: {
    defaultValue: false,
    flags: [{ key: 'debug', resolve: booleanFlag }],
  },
};

const fileConfigShape = Object.fromEntries(
  Object.values(configSources).flatMap((source) => {
    return source.file === undefined ? [] : [[source.file.key, source.file.schema.optional()]];
  })
) as z.ZodRawShape;

const envShape = Object.fromEntries(
  Object.values(configSources).flatMap((source) => {
    return source.env === undefined ? [] : [[source.env.key, source.env.schema.optional()]];
  })
) as z.ZodRawShape;

export const fileConfigSchema = z.object(fileConfigShape).strict();
export const envSchema = z.object(envShape).strip();
