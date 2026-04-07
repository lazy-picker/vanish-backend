import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import "dotenv/config";
import fs from "node:fs";
import { Readable } from "node:stream";

const { ACCOUNT_ID, ACCESS_KEY_ID, SECRET_KEY } = process.env;

export const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: `${ACCESS_KEY_ID}`,
    secretAccessKey: `${SECRET_KEY}`,
  },
});

export default async function Upload(
  userId: string,
  fileName: string,
  filePath: string,
) {
  const key = `${userId}/${fileName}`;
  const fileBuffer = fs.readFileSync(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: "vanish",
      Key: key,
      Body: fileBuffer,
    }),
  );
  console.log(`Uploaded ${key}`);
  return key;
}

export async function ListUserFiles(userId: string) {
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: "vanish",
      Prefix: `${userId}/`,
    }),
  );
  return (response.Contents ?? []).map((obj) => ({
    key: obj.Key,
    fileName: obj.Key!.replace(`${userId}/`, ""),
    size: obj.Size,
    lastModified: obj.LastModified,
    url: `/files/${obj.Key!.replace(`${userId}/`, "")}`,
  }));
}

export async function DeleteUserFile(userId: string, fileName: string) {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: "vanish",
      Key: `${userId}/${fileName}`,
    }),
  );
}

export async function GetUserFile(
  userId: string,
  fileName: string,
): Promise<Readable> {
  const key = `${userId}/${fileName}`;
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: "vanish",
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error("File not found or empty response from R2");
  }

  // SDK v3 returns a web ReadableStream — convert to Node.js Readable
  return Readable.from(response.Body as any);
}
