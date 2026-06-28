import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log("ALL ENV KEYS:", Object.keys(process.env).filter(k => k.includes("DATABASE") || k.includes("POSTGRES") || k.includes("PG")).join(", "));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contributions (
      id SERIAL PRIMARY KEY,
      artist_name TEXT NOT NULL,
      image_path TEXT NOT NULL,
      grid_x INTEGER NOT NULL,
      grid_y INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("DB ready");
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const GRID_SIZE = 20;

app.get("/api/health", (req, res) => { res.json({ ok: true }); });

app.get("/api/contributions", async (req, res) => {
  const result = await pool.query(`SELECT id, artist_name as "artistName", image_path as "imagePath", grid_x as "gridX", grid_y as "gridY", created_at as "createdAt" FROM contributions ORDER BY created_at DESC`);
  res.json(result.rows);
});

app.get("/api/contributions/stats", async (req, res) => {
  const result = await pool.query("SELECT COUNT(*)::int as count FROM contributions");
  const total = result.rows[0].count;
  res.json({ totalContributions: total, gridSize: GRID_SIZE, filledSlots: total });
});

app.get("/api/contributions/recent", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 12;
  const result = await pool.query(`SELECT id, artist_name as "artistName", image_path as "imagePath", grid_x as "gridX", grid_y as "gridY", created_at as "createdAt" FROM contributions ORDER BY created_at DESC LIMIT $1`, [limit]);
  res.json(result.rows);
});

app.post("/api/contributions", upload.single("image"), async (req, res): Promise<void> => {
  try {
    const { artistName, email } = req.body;

    if (!artistName) { res.status(400).json({ error: "artistName is required" }); return; }

    let imagePath = "";
    if (req.file) {
      const result = await new Promise<any>((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: "uff-mosaic", resource_type: "image" },
          (error, result) => { if (error) reject(error); else resolve(result); }
        ).end(req.file!.buffer);
      });
      imagePath = result.secure_url;
    }

    if (!imagePath) { res.status(400).json({ error: "image is required" }); return; }

    const countResult = await pool.query("SELECT COUNT(*)::int as count FROM contributions");
    const total = countResult.rows[0].count;
    const gridX = total % GRID_SIZE;
    const gridY = Math.floor(total / GRID_SIZE);

    const insertResult = await pool.query(
      `INSERT INTO contributions (artist_name, image_path, grid_x, grid_y) VALUES ($1, $2, $3, $4) RETURNING id, artist_name as "artistName", image_path as "imagePath", grid_x as "gridX", grid_y as "gridY", created_at as "createdAt"`,
      [artistName, imagePath, gridX, gridY]
    );

    const row = insertResult.rows[0];

    // Log to Google Sheets via Apps Script
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (appsScriptUrl) {
      fetch(appsScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          type: "mosaic",
          artistName: artistName,
          email: email || "",
          tile: `(${row.gridX}, ${row.gridY})`,
          imagePath: imagePath
        })
      }).catch((err) => console.error("Apps Script logging failed:", err));
    }

    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
