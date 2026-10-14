
import express from "express";
import helmet from "helmet";
import multer from "multer";
import AdmZip from "adm-zip";
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const app = express();
app.disable("x-powered-by");
app.use(helmet());

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.APKFORGE_BUILD_WORKER_TOKEN || "";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});

function authorized(req) {
  if (!TOKEN) return false;
  const supplied = Buffer.from(req.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  return supplied.length === expected.length &&
    timingSafeEqual(supplied, expected);
}

function run(command, args, cwd, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    const collect = data => {
      log = (log + data.toString()).slice(-12000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      code === 0
        ? resolve(log)
        : reject(new Error(`Build command failed (${code}):\n${log}`));
    });
  });
}

function validatePackageId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}$/.test(id)) {
    throw new Error("Use a package ID like com.example.myapp");
  }
  return id;
}

app.get("/", (_req, res) => {
  res.json({ service: "APKFORGE Build Worker", health: "/health" });
});

app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    status: "ok",
    service: "apkforge-build-worker",
    contractVersion: 1,
    apkBuildsEnabled: Boolean(TOKEN)
  });
});

app.post("/build", async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  upload.single("source")(req, res, async uploadError => {
    if (uploadError) {
      return res.status(400).json({ error: uploadError.message });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Upload an HTML or ZIP file in the source field."
      });
    }

    const original = (req.file.originalname || "").toLowerCase();
    if (!original.endsWith(".html") &&
        !original.endsWith(".htm") &&
        !original.endsWith(".zip")) {
      return res.status(400).json({
        error: "Only HTML and ZIP uploads are supported."
      });
    }

    let root;
    try {
      const appName = String(req.body.appName || "My Website")
        .trim().slice(0, 50);
      const packageId = validatePackageId(req.body.packageId);
      const version = String(req.body.version || "1.0.0");

      if (!appName || /[<>\\]/.test(appName)) {
        throw new Error("Invalid app name.");
      }
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error("Version must look like 1.0.0");
      }

      root = await fs.mkdtemp(path.join(os.tmpdir(), "apkforge-"));
      const project = path.join(root, "project");
      const web = path.join(project, "www");
      await fs.mkdir(web, { recursive: true });

      if (original.endsWith(".zip")) {
        const zip = new AdmZip(req.file.buffer);
        const entries = zip.getEntries();
        if (!entries.length || entries.length > 500) {
          throw new Error("ZIP must contain no more than 500 entries.");
        }

        let total = 0;
        for (const entry of entries) {
          const name = entry.entryName.replace(/\\/g, "/");
          if (name.startsWith("/") ||
              name.split("/").includes("..")) {
            throw new Error("Unsafe ZIP file path detected.");
          }
          if (entry.isDirectory) continue;

          const data = entry.getData();
          total += data.length;
          if (total > 100 * 1024 * 1024) {
            throw new Error("Uncompressed ZIP exceeds 100 MB.");
          }

          const target = path.resolve(web, name);
          if (!target.startsWith(path.resolve(web) + path.sep)) {
            throw new Error("Unsafe ZIP path.");
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, data);
        }
      } else {
        await fs.writeFile(path.join(web, "index.html"), req.file.buffer);
      }

      try {
        await fs.access(path.join(web, "index.html"));
      } catch {
        try {
          await fs.rename(
            path.join(web, "index.htm"),
            path.join(web, "index.html")
          );
        } catch {
          throw new Error("ZIP must have index.html at its root.");
        }
      }

      await fs.writeFile(
        path.join(project, "package.json"),
        JSON.stringify({
          name: "apkforge-generated-app",
          version: "1.0.0",
          private: true,
          dependencies: { "@capacitor/core": "7.4.3" },
          devDependencies: {
            "@capacitor/cli": "7.4.3",
            "@capacitor/android": "7.4.3"
          }
        }, null, 2)
      );

      await fs.writeFile(
        path.join(project, "capacitor.config.json"),
        JSON.stringify({
          appId: packageId,
          appName,
          webDir: "www",
          bundledWebRuntime: false
        }, null, 2)
      );

      await run("npm", ["install", "--no-audit", "--no-fund"], project);
      await run("npx", ["cap", "add", "android"], project);
      await run("npx", ["cap", "sync", "android"], project);

      const gradlePath = path.join(
        project, "android", "app", "build.gradle"
      );
      let gradle = await fs.readFile(gradlePath, "utf8");
      gradle = gradle.replace(/versionName\s+"[^"]*"/,
        `versionName "${version}"`);
      await fs.writeFile(gradlePath, gradle);

      await run(
        "bash",
        ["-lc", "chmod +x ./gradlew && ./gradlew assembleDebug --no-daemon"],
        path.join(project, "android")
      );

      const apkPath = path.join(
        project, "android", "app", "build", "outputs",
        "apk", "debug", "app-debug.apk"
      );
      const apk = await fs.readFile(apkPath);

      res.set({
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="apkforge-debug.apk"',
        "Cache-Control": "no-store"
      });
      return res.send(apk);
    } catch (error) {
      console.error("APK build failed:", error);
      return res.status(400).json({
        error: "APK build failed",
        message: String(error.message || error).slice(0, 4000)
      });
    } finally {
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`APKFORGE worker listening on port ${PORT}`);
});
