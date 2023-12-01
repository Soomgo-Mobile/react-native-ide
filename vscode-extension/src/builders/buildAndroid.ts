import loadConfig from "@react-native-community/cli-config";
import { getCpuArchitecture } from "../utilities/common";

const execa = require("execa");
const path = require("path");
const os = require("os");

const ANDROID_HOME = process.env.ANDROID_HOME || path.join(os.homedir(), "Library/Android/sdk");
const AAPT_PATH = path.join(ANDROID_HOME, "build-tools", "33.0.0", "aapt");

async function build(projectDir: string, gradleArgs: string[]) {
  await execa("./gradlew", gradleArgs, {
    cwd: projectDir,
  });
}

async function extractPackageName(artifactPath: string) {
  const { stdout } = await execa(AAPT_PATH, ["dump", "badging", artifactPath]);
  const packageLine = stdout.split("\n").find((line: string) => line.startsWith("package: name="));
  const packageName = packageLine!.split("'")[1];
  return packageName;
}

export async function buildAndroid(workspaceDir: string) {
  const ctx = loadConfig(workspaceDir);
  const androidSourceDir = ctx.project.android!.sourceDir;
  const cpuArchitecture = getCpuArchitecture();
  const gradleArgs = [
    "-x",
    "lint",
    `-PreactNativeArchitectures=${cpuArchitecture}`,
    `assembleDebug`,
  ];
  try {
    await build(androidSourceDir, gradleArgs);
  } catch (e) {
    console.error("Error building Android", e);
    throw e;
  }
  console.log("android build sucessful");
  const apkPath = path.join(androidSourceDir, "app/build/outputs/apk/debug/app-debug.apk");
  const packageName = await extractPackageName(apkPath);
  return { apkPath, packageName };
}
