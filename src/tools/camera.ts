import { type ToolEntry, dispatchTool } from "../registry.js";

/**
 * Studio camera control.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const CAMERA_TOOLS: ToolEntry[] = [
  dispatchTool(
    {
      name: "camera_set",
      category: "camera",
      subcategories: ["vision", "orient", "control"],
      keywords: ["camera", "orient", "look", "fov", "focus", "view", "perspective"],
      description:
        "Orient the workspace camera: set CFrame (12-number array), or position + lookAt, or just one. Optional fov and focus (position array or ref).",
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "array", items: { type: "number" }, description: "World [x,y,z]." },
          lookAt: { type: "array", items: { type: "number" }, description: "Aim at world [x,y,z]." },
          cframe: {
            type: "array",
            items: { type: "number" },
            description: "Full CFrame as 12 numbers (x,y,z,r00..r22). Overrides position/lookAt.",
          },
          fov: { type: "number", description: "FieldOfView (degrees)." },
          focus: {
            description: "Focus point: world [x,y,z] array or a ref/path string.",
            oneOf: [
              { type: "array", items: { type: "number" } },
              { type: "string" },
            ],
          },
        },
      },
    },
    "camera_set",
  ),
];
