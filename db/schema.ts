import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const files = pgTable("File", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  fileName: text("fileName").notNull(),
  fileKey: text("fileKey").notNull().unique(), // <--- Ensure .unique() is here
  size: integer("size").notNull(),
  downloadLimit: integer("downloadLimit").default(5).notNull(),
  downloadCount: integer("downloadCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
});
