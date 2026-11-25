import { copyFile } from "node:fs/promises";
import sharp from "sharp";

const image = "public/art/og/templ-og.png";
await sharp("public/art/og/templ-og.svg").png({ compressionLevel: 9 }).toFile(image);
await copyFile(image, "public/images/templ-chat.png");
