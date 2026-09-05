import { expect, test } from "bun:test";
import { modelDisplayName, modelMetadata } from "../src/metadata";
import { configModel } from "../src/index";

const id = "gpt-5.6-terra";
const payload = { [`openai/${id}`]: { name: "GPT-5.6 Terra" } };

test("ID-shaped Codex labels use the exact OpenAI catalog name in OpenCode", () => {
  for (const raw of [id, id.toUpperCase(), "", undefined]) {
    const label = modelDisplayName(id, raw, payload);
    expect(label).toEqual({ name: "GPT-5.6 Terra", source: "models.dev:exact-openai-id" });
    expect(configModel({ ...modelMetadata(id, payload), id, name: label.name, description: "", efforts: [], nativeInputModalities: ["text"], isDefault: true }).name).toBe("GPT-5.6 Terra");
  }
});

test("meaningful official labels take priority over generic metadata", () => {
  expect(modelDisplayName(id, "GPT-5.6 Terra Preview", payload)).toEqual({ name: "GPT-5.6 Terra Preview", source: "codex-app-server:model/list" });
});

test("missing metadata preserves IDs and never borrows names from other variants or providers", () => {
  for (const metadata of [{}, { [`other/${id}`]: { name: "Wrong provider" } }, { "openai/gpt-5.6": { name: "Wrong variant" } }, { [`openai/${id}`]: { name: "   " } }, { [`openai/${id}`]: { name: 42 } }]) {
    expect(modelDisplayName(id, id, metadata).name).toBe(id);
    expect(modelDisplayName(id, undefined, metadata)).toEqual({ name: id, source: "model-id" });
  }
});

test("nested catalogs and OpenAI-prefixed IDs use exact metadata", () => {
  expect(modelDisplayName(`openai/${id}`, id, { openai: { models: { [id]: { name: "GPT-5.6 Terra" } } } }).name).toBe("GPT-5.6 Terra");
});
