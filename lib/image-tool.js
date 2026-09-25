/**
 * Image generation tool for Google Antigravity / Gemini image models.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

function isInsideRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sanitizeImageFilename(value) {
  if (value === undefined || value === null || value === "") return null;
  const base = String(value).split(/[\\/]/).pop();
  if (!/^[\w.-]+$/.test(base)) {
    throw new Error(`image filename must contain only letters, digits, dot, dash or underscore, got: ${value}`);
  }
  return /\.(png|jpe?g|webp)$/i.test(base) ? base : `${base}.png`;
}

export function createImageGenerateTool(poolManager, sendImageRequestFn) {
  return {
    name: "antigravity_image_generate",
    description:
      "Generate frontend image assets using Google Antigravity (Gemini 3.1 Flash Image) from the multi-account pool. Automatically saves to workspace assets folder and returns relative path for use in HTML/React code.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate, including style, lighting, subjects, and colors.",
        },
        filename: {
          type: "string",
          description: "Optional output filename, e.g. hero-bg.png, feature-chart.png. Defaults to generated name.",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory relative to project root. Defaults to assets/images.",
        },
      },
      required: ["prompt"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          prompt: { type: "string" },
          markdown: { type: "string" },
        },
      },
      render: (value) => [
        {
          type: "text",
          text: `Generated image: ${value.path}\n\n${value.markdown}`,
        },
      ],
    },
    execute: async (args) => {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error("Image prompt must not be empty.");

      const root = process.cwd();
      const configDir = poolManager.imageOutputDir;
      const rawDir = args.output_dir || configDir || "./assets/images";
      const absDir = resolve(root, rawDir);
      const isUserConfiguredDir = Boolean(configDir) && absDir === resolve(root, configDir);
      if (!isUserConfiguredDir && !isInsideRoot(absDir, root)) {
        throw new Error(`image output_dir must resolve inside the project root, got: ${rawDir}`);
      }

      const hash = createHash("md5").update(prompt + Date.now()).digest("hex").slice(0, 8);
      const filename = sanitizeImageFilename(args.filename) ?? `img-${hash}.png`;

      const targetPath = join(rawDir, filename);
      const absPath = resolve(root, targetPath);

      // Call Google Cloud Code Assist through the pool
      const result = await sendImageRequestFn(prompt);
      if (!result?.base64) {
        throw new Error(result?.error || "Failed to generate image from Google Antigravity.");
      }

      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, Buffer.from(result.base64, "base64"));

      return {
        path: targetPath,
        absolutePath: absPath,
        filename,
        prompt,
        usedAccount: result.accountEmail,
        markdown: `![${filename}](${targetPath})`,
      };
    },
  };
}
