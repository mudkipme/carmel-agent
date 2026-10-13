import { createReadTool as read } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
export { createWriteTool, createEditTool, createBashTool } from "@earendil-works/pi-durable/tools";

let images: ReturnType<typeof createNodePhotonImages> | undefined;
export function createReadTool() {
  return {
    ...read({
      images: {
        async prepare(bytes, mimeType, limits) {
          images ??= createNodePhotonImages();
          return (await images).prepare(bytes, mimeType, limits);
        },
      },
    }),
    replay: "safe" as const,
  };
}
