import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (value.length < 16 || value.length > 1024) {
  console.error(
    "Введите пароль длиной от 16 до 1024 символов через стандартный ввод.",
  );
  process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString("hex");
  console.log(`scrypt:${salt}:${scryptSync(value, salt, 64).toString("hex")}`);
}
