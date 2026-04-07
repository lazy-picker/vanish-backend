import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import crypto from "node:crypto";
import { verifyToken } from "./firebase/auth.js";
import Upload, {
  ListUserFiles,
  DeleteUserFile,
  GetUserFile,
} from "./s3/buket.js";
import { prisma } from "./db/prisma.js";

// Define a custom request type for Firebase Auth
interface AuthRequest extends Request {
  user?: { uid: string };
}

const app = express();
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const TEMP_DIR = path.join(UPLOAD_DIR, "temp");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-upload-id",
      "content-range",
    ],
  }),
);

// 1. GET: Byte Serving
app.get("/files/:filename", (req: Request, res: Response) => {
  try {
    const filePath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": "application/octet-stream",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    res.status(500).send("Error serving file");
  }
});

// 2. POST: Init
app.post("/upload/init", (req: Request, res: Response) => {
  res.json({ uploadId: crypto.randomUUID() });
});

// 3. POST: Chunk
app.post(
  "/upload/chunk",
  verifyToken,
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  (req: AuthRequest, res: Response) => {
    try {
      const uploadId = req.headers["x-upload-id"] as string;
      const range = req.headers["content-range"] as string;
      const match = range?.match(/bytes (\d+)-/);

      if (!uploadId || !match)
        return res.status(400).json({ error: "Invalid headers" });

      const chunkDir = path.join(TEMP_DIR, path.basename(uploadId));
      if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

      fs.writeFileSync(path.join(chunkDir, `chunk-${match[1]}`), req.body);
      res.sendStatus(200);
    } catch (error) {
      res.status(500).json({ error: "Chunk failed" });
    }
  },
);

// 4. POST: Complete
app.post(
  "/upload/complete",
  express.json(),
  verifyToken,
  async (req: AuthRequest, res: Response) => {
    const { uploadId, fileName, downloadLimit = 5 } = req.body;
    const userId = req.user?.uid;

    if (!uploadId || !fileName || !userId)
      return res.status(400).json({ error: "Missing data" });

    const chunkDir = path.join(TEMP_DIR, path.basename(uploadId));
    const safeName = path.basename(fileName);
    const finalPath = path.join(
      UPLOAD_DIR,
      `${crypto.randomUUID()}-${safeName}`,
    );

    try {
      if (!fs.existsSync(chunkDir)) throw new Error("Upload directory missing");

      const chunks = fs
        .readdirSync(chunkDir)
        .sort((a, b) => parseInt(a.split("-")[1]) - parseInt(b.split("-")[1]));

      const writeStream = fs.createWriteStream(finalPath);
      for (const chunk of chunks) {
        writeStream.write(fs.readFileSync(path.join(chunkDir, chunk)));
      }
      writeStream.end();

      await new Promise((resolve) => writeStream.on("finish", resolve));

      const fileSize = fs.statSync(finalPath).size;
      const fileKey = `${userId}/${safeName}`;

      await Upload(userId, safeName, finalPath);

      await prisma.file.upsert({
        where: { fileKey },
        update: {
          downloadLimit: Number(downloadLimit),
          downloadCount: 0,
          size: fileSize,
        },
        create: {
          userId,
          fileName: safeName,
          fileKey,
          size: fileSize,
          downloadLimit: Number(downloadLimit),
          downloadCount: 0,
        },
      });

      res.json({ message: "Complete", fileName: safeName });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    } finally {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      if (fs.existsSync(chunkDir))
        fs.rmSync(chunkDir, { recursive: true, force: true });
    }
  },
);

// 5. GET: List
app.get("/files", verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const [r2Files, dbFiles] = await Promise.all([
      ListUserFiles(userId),
      prisma.file.findMany({ where: { userId } }),
    ]);

    const dbMap = new Map(dbFiles.map((f) => [f.fileKey, f]));
    const files = r2Files.map((f) => {
      const db = dbMap.get(f.key as string);
      return {
        ...f,
        downloadLimit: db?.downloadLimit ?? 5,
        downloadCount: db?.downloadCount ?? 0,
      };
    });

    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: "List failed" });
  }
});

// 6. DELETE
app.delete(
  "/files/:fileName",
  verifyToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.uid;
      const name = decodeURIComponent(req.params.fileName);
      await Promise.all([
        DeleteUserFile(userId, name),
        prisma.file.deleteMany({ where: { fileKey: `${userId}/${name}` } }),
      ]);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ error: "Delete failed" });
    }
  },
);

// 7. GET: Download
app.get("/download/:userId/:fileName", async (req: Request, res: Response) => {
  try {
    const { userId, fileName } = req.params;
    const decoded = decodeURIComponent(fileName);
    const fileKey = `${userId}/${decoded}`;

    const record = await prisma.file.findUnique({ where: { fileKey } });
    if (!record) return res.status(404).send("Not found");

    if (
      record.downloadLimit > 0 &&
      record.downloadCount >= record.downloadLimit
    ) {
      return res.status(410).send("Limit reached");
    }

    const stream = await GetUserFile(userId, decoded);
    res.setHeader("Content-Disposition", `attachment; filename="${decoded}"`);

    if (
      record.downloadLimit > 0 &&
      record.downloadCount + 1 >= record.downloadLimit
    ) {
      await Promise.all([
        DeleteUserFile(userId, decoded),
        prisma.file.delete({ where: { fileKey } }),
      ]);
    } else {
      await prisma.file.update({
        where: { fileKey },
        data: { downloadCount: { increment: 1 } },
      });
    }

    stream.pipe(res);
  } catch (error) {
    res.status(500).send("Download failed");
  }
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
