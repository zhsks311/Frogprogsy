import * as z from "zod/v4";

export type CatalogSource = "remote" | "cached" | "bundled";

export interface ModelCatalogModelV1 {
  id: string;
  minFrogprogsyVersion?: string;
  contextWindow?: number;
  inputModalities?: ("text" | "image")[];
  reasoningEfforts?: ("low" | "medium" | "high" | "xhigh")[];
  reasoningEffortMap?: Record<string, string>;
  wireModelId?: string;
  noReasoning?: boolean;
  noTemperature?: boolean;
  noTopP?: boolean;
  noPenalty?: boolean;
  autoToolChoiceOnly?: boolean;
  preserveReasoningContent?: boolean;
}

export interface ModelCatalogProviderV1 {
  id: string;
  minFrogprogsyVersion?: string;
  defaultModel?: string;
  retiredModels?: string[];
  unmanagedModels?: string[];
  escapeBuiltinToolNames?: boolean;
  models: ModelCatalogModelV1[];
}

export interface ModelCatalogDocumentV1 {
  schemaVersion: 1;
  catalogRevision: number;
  catalogDigest: string;
  sourceCommit: string;
  generatedAt: string;
  minFrogprogsyVersion: string;
  providers: ModelCatalogProviderV1[];
}

export const catalogSourceSchema = z.enum(["remote", "cached", "bundled"]);

const nonEmptyStringSchema = z.string().min(1);
const uniqueValues = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const modelCatalogModelV1Schema = z.strictObject({
  id: nonEmptyStringSchema,
  minFrogprogsyVersion: nonEmptyStringSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  inputModalities: z.array(z.enum(["text", "image"])).optional(),
  reasoningEfforts: z.array(z.enum(["low", "medium", "high", "xhigh"])).optional(),
  reasoningEffortMap: z.record(z.string(), z.string()).optional(),
  wireModelId: nonEmptyStringSchema.optional(),
  noReasoning: z.boolean().optional(),
  noTemperature: z.boolean().optional(),
  noTopP: z.boolean().optional(),
  noPenalty: z.boolean().optional(),
  autoToolChoiceOnly: z.boolean().optional(),
  preserveReasoningContent: z.boolean().optional(),
}).superRefine((model, context) => {
  if (model.noReasoning === true && (model.reasoningEfforts?.length ?? 0) > 0) {
    context.addIssue({
      code: "custom",
      message: "A model without reasoning cannot declare reasoning efforts",
      path: ["reasoningEfforts"],
    });
  }
  if (model.noReasoning === true && Object.keys(model.reasoningEffortMap ?? {}).length > 0) {
    context.addIssue({
      code: "custom",
      message: "A model without reasoning cannot declare a reasoning effort map",
      path: ["reasoningEffortMap"],
    });
  }
});

export const modelCatalogProviderV1Schema = z.strictObject({
  id: nonEmptyStringSchema,
  minFrogprogsyVersion: nonEmptyStringSchema.optional(),
  defaultModel: nonEmptyStringSchema.optional(),
  retiredModels: z.array(nonEmptyStringSchema).optional(),
  unmanagedModels: z.array(nonEmptyStringSchema).optional(),
  escapeBuiltinToolNames: z.boolean().optional(),
  models: z.array(modelCatalogModelV1Schema),
}).superRefine((provider, context) => {
  const modelIds = provider.models.map(model => model.id);
  if (!uniqueValues(modelIds)) {
    context.addIssue({
      code: "custom",
      message: "Model IDs must be unique within a provider",
      path: ["models"],
    });
  }

  const activeModelIds = new Set(modelIds);
  if (provider.defaultModel !== undefined && !activeModelIds.has(provider.defaultModel)) {
    context.addIssue({
      code: "custom",
      message: "The default model must reference an active model",
      path: ["defaultModel"],
    });
  }

  if (provider.retiredModels !== undefined) {
    if (!uniqueValues(provider.retiredModels)) {
      context.addIssue({
        code: "custom",
        message: "Retired model IDs must be unique",
        path: ["retiredModels"],
      });
    }
    for (const retiredModel of provider.retiredModels) {
      if (activeModelIds.has(retiredModel)) {
        context.addIssue({
          code: "custom",
          message: "A retired model cannot also be active",
          path: ["retiredModels"],
        });
      }
    }
  }

  if (provider.unmanagedModels !== undefined) {
    if (provider.unmanagedModels.length > 0 && provider.minFrogprogsyVersion === undefined) {
      context.addIssue({
        code: "custom",
        message: "A provider with unmanaged models must declare a minimum Frogprogsy version",
        path: ["minFrogprogsyVersion"],
      });
    }
    if (!uniqueValues(provider.unmanagedModels)) {
      context.addIssue({
        code: "custom",
        message: "Unmanaged model IDs must be unique",
        path: ["unmanagedModels"],
      });
    }
    const retiredModelIds = new Set(provider.retiredModels ?? []);
    for (const unmanagedModel of provider.unmanagedModels) {
      if (activeModelIds.has(unmanagedModel) || retiredModelIds.has(unmanagedModel)) {
        context.addIssue({
          code: "custom",
          message: "An unmanaged model cannot also be active or retired",
          path: ["unmanagedModels"],
        });
      }
    }
  }
});

export const modelCatalogDocumentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogRevision: z.number().int().positive(),
  catalogDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  generatedAt: z.iso.datetime({ offset: true }),
  minFrogprogsyVersion: nonEmptyStringSchema,
  providers: z.array(modelCatalogProviderV1Schema),
}).superRefine((document, context) => {
  const providerIds = document.providers.map(provider => provider.id);
  if (!uniqueValues(providerIds)) {
    context.addIssue({
      code: "custom",
      message: "Provider IDs must be unique",
      path: ["providers"],
    });
  }
});
