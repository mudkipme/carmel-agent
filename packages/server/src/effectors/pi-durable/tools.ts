import { createReadTool as read } from "@earendil-works/pi-durable/tools";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
export { createWriteTool, createEditTool, createBashTool } from "@earendil-works/pi-durable/tools";

let images: ReturnType<typeof createNodePhotonImages> | undefined;
export const imageProcessor: ImageProcessor = {
  async prepare(bytes, mimeType, limits) {
    images ??= createNodePhotonImages();
    return (await images).prepare(bytes, mimeType, limits);
  },
};

export function createReadTool() {
  return { ...read({ images: imageProcessor }), replay: "safe" as const };
}

/** Fits images from any tool result (MCP, Codemode `image()`) to the model's limits, as `read` does. */
export const fitToolImages = createFitImagesExtension(imageProcessor);
