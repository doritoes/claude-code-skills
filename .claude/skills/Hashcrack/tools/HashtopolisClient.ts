#!/usr/bin/env bun
/**
 * HashtopolisClient.ts - Hashtopolis REST API Client
 *
 * TypeScript client for interacting with Hashtopolis server API.
 * Handles authentication, hashlist management, task creation, and progress monitoring.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface HashtopolisConfig {
  serverUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface HashlistCreateParams {
  name: string;
  hashTypeId: number;
  hashes: string[];
  isSalted?: boolean;
  separator?: string;
}

export interface TaskCreateParams {
  name: string;
  hashlistId: number;
  attackCmd: string;
  chunkTime?: number;
  priority?: number;
  maxAgents?: number;
  isCpuTask?: boolean;
  files?: number[]; // File IDs for wordlists/rules
}

export interface TaskStatus {
  taskId: number;
  name: string;
  hashlistId: number;
  keyspace: number;
  keyspaceProgress: number;
  crackedHashes: number;
  hashCount: number;
  speed: number;
  isArchived: boolean;
  percentComplete: number;
}

export interface CrackedHash {
  hash: string;
  plain: string;
}

export interface Agent {
  agentId: number;
  agentName: string;
  devices: string[];
  isActive: boolean;
  isTrusted: boolean;
  lastAction: string;
  lastIp: string;
}

export interface ApiResponse {
  section: string;
  request: string;
  response: "OK" | "ERROR";
  message?: string;
  [key: string]: unknown;
}

// =============================================================================
// Hash Type Definitions
// =============================================================================

export const HASH_TYPES: Record<string, number> = {
  md5: 0,
  sha1: 100,
  sha256: 1400,
  sha512: 1700,
  md5crypt: 500,
  sha256crypt: 7400,
  sha512crypt: 1800,
  bcrypt: 3200,
  lm: 3000,
  ntlm: 1000,
  netntlmv1: 5500,
  netntlmv2: 5600,
  "kerberos-asrep": 18200,
  "kerberos-tgs": 13100,
  mssql2005: 132,
  mssql2012: 1731,
  mysql: 300,
  postgresql: 12,
};

// =============================================================================
// API Client Class
// =============================================================================

export class HashtopolisClient {
  private serverUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: HashtopolisConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 300000; // 5 minutes for large uploads
  }

  /**
   * Create client from environment variables
   */
  static fromEnv(): HashtopolisClient {
    // Check multiple possible .env locations (Windows and Unix)
    const possiblePaths = [
      resolve(process.env.USERPROFILE || "", "AI-Projects/.claude/.env"),
      resolve(process.env.HOME || "", ".claude/.env"),
      resolve(process.env.HOME || "", "AI-Projects/.claude/.env"),
      resolve(__dirname, "../../../.env"),
    ];

    for (const envPath of possiblePaths) {
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, "utf-8");
        const env: Record<string, string> = {};

        for (const line of envContent.split("\n")) {
          const match = line.match(/^([^=]+)=(.*)$/);
          if (match) {
            env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
          }
        }

        if (env.HASHCRACK_SERVER_URL && env.HASHCRACK_API_KEY) {
          return new HashtopolisClient({
            serverUrl: env.HASHCRACK_SERVER_URL,
            apiKey: env.HASHCRACK_API_KEY,
          });
        }
      }
    }

    // Fallback: check process.env directly
    if (process.env.HASHCRACK_SERVER_URL && process.env.HASHCRACK_API_KEY) {
      return new HashtopolisClient({
        serverUrl: process.env.HASHCRACK_SERVER_URL,
        apiKey: process.env.HASHCRACK_API_KEY,
      });
    }

    throw new Error(
      "Hashtopolis credentials not found. Set HASHCRACK_SERVER_URL and HASHCRACK_API_KEY in .claude/.env"
    );
  }

  /**
   * DEPRECATED: Old fromEnv implementation
   */
  static fromEnvLegacy(): HashtopolisClient {
    const envPath = resolve(process.env.HOME || "", ".claude/.env");

    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      const env: Record<string, string> = {};

      for (const line of envContent.split("\n")) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
        }
      }

      if (env.HASHCRACK_SERVER_URL && env.HASHCRACK_API_KEY) {
        return new HashtopolisClient({
          serverUrl: env.HASHCRACK_SERVER_URL,
          apiKey: env.HASHCRACK_API_KEY,
        });
      }
    }

    throw new Error(
      "Hashtopolis credentials not found. Set HASHCRACK_SERVER_URL and HASHCRACK_API_KEY in .claude/.env"
    );
  }

  /**
   * Make API request to Hashtopolis
   */
  private async request(
    section: string,
    requestType: string,
    params: Record<string, unknown> = {}
  ): Promise<ApiResponse> {
    const body = {
      section,
      request: requestType,
      accessKey: this.apiKey,
      ...params,
    };

    const response = await fetch(`${this.serverUrl}/api/user.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as ApiResponse;

    if (data.response === "ERROR") {
      throw new Error(`Hashtopolis API error: ${data.message}`);
    }

    return data;
  }

  // ===========================================================================
  // Hashlist Operations
  // ===========================================================================

  /**
   * Create a new hashlist
   */
  async createHashlist(params: HashlistCreateParams): Promise<number> {
    // Base64 encode the hashes
    const hashData = Buffer.from(params.hashes.join("\n")).toString("base64");

    const response = await this.request("hashlist", "createHashlist", {
      name: params.name,
      hashtypeId: params.hashTypeId, // Note: lowercase 't' required by API
      format: 0, // text format
      separator: params.separator || ":",
      isSalted: params.isSalted || false,
      isSecret: false, // REQUIRED - allows agents to access the hashes
      isHexSalt: false,
      accessGroupId: 1,
      data: hashData,
      useBrain: false,
      brainFeatures: 0,
    });

    return response.hashlistId as number;
  }

  /**
   * Get hashlist details
   */
  async getHashlist(hashlistId: number): Promise<Record<string, unknown>> {
    const response = await this.request("hashlist", "getHashlist", {
      hashlistId,
    });
    return response;
  }

  /**
   * List all hashlists
   */
  async listHashlists(): Promise<Array<Record<string, unknown>>> {
    const response = await this.request("hashlist", "listHashlists");
    return (response.hashlists as Array<Record<string, unknown>>) || [];
  }

  /**
   * Find hashlist by name
   * Returns hashlistId if found, null if not
   */
  async findHashlistByName(name: string): Promise<number | null> {
    const hashlists = await this.listHashlists();
    const found = hashlists.find((h) => h.hashlistName === name);
    return found ? (found.hashlistId as number) : null;
  }

  /**
   * Get cracked hashes from a hashlist
   */
  async getCrackedHashes(hashlistId: number): Promise<CrackedHash[]> {
    const response = await this.request("hashlist", "getCracked", {
      hashlistId,
    });
    return (response.cracked as CrackedHash[]) || [];
  }

  /**
   * Delete a hashlist
   */
  async deleteHashlist(hashlistId: number): Promise<void> {
    await this.request("hashlist", "deleteHashlist", { hashlistId });
  }

  // ===========================================================================
  // Task Operations
  // ===========================================================================

  /**
   * Create a new cracking task
   */
  async createTask(params: TaskCreateParams): Promise<number> {
    const response = await this.request("task", "createTask", {
      name: params.name,
      hashlistId: params.hashlistId,
      attackCmd: params.attackCmd,
      chunkTime: params.chunkTime || 600,
      statusTimer: 5,
      priority: params.priority || 10,
      maxAgents: params.maxAgents || 0,
      color: "#00FF00",
      isCpuTask: params.isCpuTask || false,
      isSmall: false,
      skipKeyspace: 0,
      crackerBinaryId: 1,
      crackerBinaryTypeId: 1,
      files: params.files || [], // Wordlist and rule file IDs
    });

    return response.taskId as number;
  }

  /**
   * Get task status
   */
  async getTaskStatus(taskId: number): Promise<TaskStatus> {
    const response = await this.request("task", "getTask", { taskId });

    const keyspace = (response.keyspace as number) || 0;
    const keyspaceProgress = (response.keyspaceProgress as number) || 0;

    return {
      taskId: response.taskId as number,
      name: response.name as string,
      hashlistId: response.hashlistId as number,
      keyspace,
      keyspaceProgress,
      crackedHashes: (response.crackedHashes as number) || 0,
      hashCount: (response.hashCount as number) || 0,
      speed: (response.speed as number) || 0,
      isArchived: (response.isArchived as boolean) || false,
      percentComplete: keyspace > 0 ? (keyspaceProgress / keyspace) * 100 : 0,
    };
  }

  /**
   * List all tasks
   */
  async listTasks(): Promise<Array<Record<string, unknown>>> {
    const response = await this.request("task", "listTasks");
    return (response.tasks as Array<Record<string, unknown>>) || [];
  }

  /**
   * Set task priority
   */
  async setTaskPriority(taskId: number, priority: number): Promise<void> {
    await this.request("task", "setTaskPriority", { taskId, priority });
  }

  /**
   * Archive a task
   */
  async archiveTask(taskId: number): Promise<void> {
    await this.request("task", "archiveTask", { taskId });
  }

  // ===========================================================================
  // Agent Operations
  // ===========================================================================

  /**
   * Create a voucher for worker registration
   */
  async createVoucher(voucher?: string): Promise<string> {
    const response = await this.request("agent", "createVoucher", {
      voucher: voucher || "",
    });
    return response.voucher as string;
  }

  /**
   * List all agents
   */
  async listAgents(): Promise<Agent[]> {
    const response = await this.request("agent", "listAgents");
    return (response.agents as Agent[]) || [];
  }

  /**
   * Set agent active status
   */
  async setAgentActive(agentId: number, isActive: boolean): Promise<void> {
    await this.request("agent", "setAgentActive", { agentId, isActive });
  }

  /**
   * Set agent trusted status
   */
  async setAgentTrusted(agentId: number, isTrusted: boolean): Promise<void> {
    await this.request("agent", "setAgentTrusted", { agentId, isTrusted });
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: number): Promise<void> {
    await this.request("agent", "deleteAgent", { agentId });
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Upload a wordlist file
   */
  async uploadWordlist(filename: string, content: string): Promise<number> {
    const data = Buffer.from(content).toString("base64");
    const response = await this.request("file", "addFile", {
      filename,
      fileType: 0, // wordlist
      accessGroupId: 1,
      data,
    });
    return response.fileId as number;
  }

  /**
   * Upload a rule file
   */
  async uploadRuleFile(filename: string, content: string): Promise<number> {
    const data = Buffer.from(content).toString("base64");
    const response = await this.request("file", "addFile", {
      filename,
      fileType: 1, // rule
      accessGroupId: 1,
      data,
    });
    return response.fileId as number;
  }

  /**
   * List all files
   */
  async listFiles(): Promise<Array<Record<string, unknown>>> {
    const response = await this.request("file", "listFiles");
    return (response.files as Array<Record<string, unknown>>) || [];
  }

  // ===========================================================================
  // Config Operations
  // ===========================================================================

  /**
   * Get server configuration
   */
  async getConfig(): Promise<Record<string, unknown>> {
    const response = await this.request("config", "listConfigs");
    return response;
  }

  /**
   * Set a configuration value
   */
  async setConfig(item: string, value: string): Promise<void> {
    await this.request("config", "setConfigValue", { item, value });
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Test connection to server
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.listAgents();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get overall job progress
   */
  async getJobProgress(hashlistId: number): Promise<{
    totalHashes: number;
    crackedHashes: number;
    percentCracked: number;
    activeTasks: number;
  }> {
    const hashlist = await this.getHashlist(hashlistId);
    const tasks = await this.listTasks();

    const hashlistTasks = tasks.filter(
      (t) => t.hashlistId === hashlistId && !t.isArchived
    );

    const totalHashes = (hashlist.hashCount as number) || 0;
    const crackedHashes = (hashlist.crackedCount as number) || 0;

    return {
      totalHashes,
      crackedHashes,
      percentCracked: totalHashes > 0 ? (crackedHashes / totalHashes) * 100 : 0,
      activeTasks: hashlistTasks.length,
    };
  }
}

// =============================================================================
// Hash Type Detection
// =============================================================================

/**
 * Attempt to auto-detect hash type from sample hash
 */
export function detectHashType(hash: string): number | null {
  const trimmed = hash.trim();

  // Length-based detection for hex hashes
  if (/^[a-f0-9]+$/i.test(trimmed)) {
    switch (trimmed.length) {
      case 32:
        return HASH_TYPES.md5;
      case 40:
        return HASH_TYPES.sha1;
      case 64:
        return HASH_TYPES.sha256;
      case 128:
        return HASH_TYPES.sha512;
    }
  }

  // Prefix-based detection
  if (trimmed.startsWith("$1$")) return HASH_TYPES.md5crypt;
  if (trimmed.startsWith("$5$")) return HASH_TYPES.sha256crypt;
  if (trimmed.startsWith("$6$")) return HASH_TYPES.sha512crypt;
  if (trimmed.startsWith("$2a$") || trimmed.startsWith("$2b$"))
    return HASH_TYPES.bcrypt;

  // NTLM (32 hex chars, typically from Windows)
  if (/^[a-f0-9]{32}$/i.test(trimmed)) {
    // Could be MD5 or NTLM - prefer NTLM if context suggests Windows
    return HASH_TYPES.ntlm;
  }

  return null;
}

/**
 * Get hash type name from ID
 */
export function getHashTypeName(hashTypeId: number): string | null {
  for (const [name, id] of Object.entries(HASH_TYPES)) {
    if (id === hashTypeId) return name;
  }
  return null;
}

// =============================================================================
// CLI Usage (when run directly)
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
HashtopolisClient - Hashtopolis API Client

Usage:
  bun HashtopolisClient.ts <command> [options]

Commands:
  test              Test connection to server
  agents            List registered agents
  hashlists         List all hashlists
  tasks             List all tasks
  status <taskId>   Get task status

Environment:
  HASHCRACK_SERVER_URL   Hashtopolis server URL
  HASHCRACK_API_KEY      API key for authentication

Example:
  bun HashtopolisClient.ts test
  bun HashtopolisClient.ts agents
  bun HashtopolisClient.ts status 42
`);
    process.exit(0);
  }

  try {
    const client = HashtopolisClient.fromEnv();
    const command = args[0];

    switch (command) {
      case "test":
        const connected = await client.testConnection();
        console.log(connected ? "Connected successfully" : "Connection failed");
        process.exit(connected ? 0 : 1);
        break;

      case "agents":
        const agents = await client.listAgents();
        console.log(JSON.stringify(agents, null, 2));
        break;

      case "hashlists":
        const hashlists = await client.listHashlists();
        console.log(JSON.stringify(hashlists, null, 2));
        break;

      case "tasks":
        const tasks = await client.listTasks();
        console.log(JSON.stringify(tasks, null, 2));
        break;

      case "status":
        if (!args[1]) {
          console.error("Usage: status <taskId>");
          process.exit(1);
        }
        const status = await client.getTaskStatus(parseInt(args[1]));
        console.log(JSON.stringify(status, null, 2));
        break;

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
