/**
 * 技能加载器 — 扫描 {workspace}/skills/ 目录下的 SKILL.md 文件
 *
 * 技能是 Markdown 文件，用于教会 Agent 特定能力
 * 支持 YAML 格式的 Frontmatter 配置：
 *   description: "..."      → 技能描述
 *   always: true            → 常驻技能，始终注入系统提示词
 *   requires:
 *     bins: [tmux, brew]    → 依赖的命令行工具
 *     env: [API_KEY]        → 依赖的环境变量
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** 技能基本信息 */
interface SkillInfo {
  name: string;                       // 技能名称（目录名）
  filePath: string;                   // SKILL.md 文件路径
  source: 'workspace' | 'builtin';    // 来源：工作区自定义 或 内置
}

/** 技能元数据（从 Frontmatter 解析） */
interface SkillMeta {
  description?: string;   // 技能描述
  always?: boolean;       // 是否常驻
  requires?: {
    bins?: string[];      // 依赖的命令行工具
    env?: string[];       // 依赖的环境变量
  };
}

export class SkillsLoader {
  private readonly _workspaceSkills: string;  // 工作区技能目录
  private readonly _builtinSkills: string | null;  // 内置技能目录

  constructor(workspace: string, builtinSkillsDir?: string) {
    this._workspaceSkills = path.join(workspace, 'skills');
    this._builtinSkills = builtinSkillsDir ?? null;
  }

  /**
   * 列出所有技能（工作区 + 内置）
   * @param filterUnavailable 是否过滤掉依赖不满足的技能
   */
  listSkills(filterUnavailable = true): SkillInfo[] {
    const skills: SkillInfo[] = [];
    const seen = new Set<string>();  // 用于去重，工作区技能优先级更高

    // 工作区技能（优先级更高，可覆盖内置同名技能）
    if (fs.existsSync(this._workspaceSkills)) {
      for (const entry of fs.readdirSync(this._workspaceSkills, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(this._workspaceSkills, entry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          skills.push({ name: entry.name, filePath: skillFile, source: 'workspace' });
          seen.add(entry.name);
        }
      }
    }

    // 内置技能（只加载工作区中不存在的）
    if (this._builtinSkills && fs.existsSync(this._builtinSkills)) {
      for (const entry of fs.readdirSync(this._builtinSkills, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const skillFile = path.join(this._builtinSkills, entry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          skills.push({ name: entry.name, filePath: skillFile, source: 'builtin' });
        }
      }
    }

    if (!filterUnavailable) return skills;
    return skills.filter((s) => this._checkRequirements(this._getSkillMeta(s.name)));
  }

  /**
   * 加载指定技能的内容
   * 优先从工作区加载，其次从内置目录加载
   */
  loadSkill(name: string): string | null {
    // 优先从工作区加载
    const wPath = path.join(this._workspaceSkills, name, 'SKILL.md');
    if (fs.existsSync(wPath)) return fs.readFileSync(wPath, 'utf-8');

    // 其次从内置目录加载
    if (this._builtinSkills) {
      const bPath = path.join(this._builtinSkills, name, 'SKILL.md');
      if (fs.existsSync(bPath)) return fs.readFileSync(bPath, 'utf-8');
    }

    return null;
  }

  /**
   * 加载多个技能并格式化为上下文字符串
   */
  loadSkillsForContext(skillNames: string[]): string {
    const parts: string[] = [];
    for (const name of skillNames) {
      const content = this.loadSkill(name);
      if (content) {
        const stripped = this._stripFrontmatter(content);
        parts.push(`### Skill: ${name}\n\n${stripped}`);
      }
    }
    return parts.join('\n\n---\n\n');
  }

  /**
   * 构建技能摘要（XML 格式）
   * Agent 可通过 read_file 工具按需加载完整技能内容
   */
  buildSkillsSummary(): string {
    const all = this.listSkills(false);
    if (all.length === 0) return '';

    const escXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const lines = ['<skills>'];
    for (const s of all) {
      const meta = this._getSkillMeta(s.name);
      const available = this._checkRequirements(meta);
      const desc = escXml(this._getSkillDescription(s.name));
      const missing = available ? '' : this._getMissingRequirements(meta);

      lines.push(`  <skill available="${available}">`);
      lines.push(`    <name>${escXml(s.name)}</name>`);
      lines.push(`    <description>${desc}</description>`);
      lines.push(`    <location>${s.filePath}</location>`);
      if (!available && missing) {
        lines.push(`    <requires>${escXml(missing)}</requires>`);
      }
      lines.push(`  </skill>`);
    }
    lines.push('</skills>');
    return lines.join('\n');
  }

  /**
   * 获取所有常驻技能名称（always=true）
   */
  getAlwaysSkills(): string[] {
    return this.listSkills(true)
      .filter((s) => {
        const fullMeta = this.getSkillMetadata(s.name);
        const nanobotMeta = this._parseNanobotMeta(fullMeta?.metadata ?? '');
        return nanobotMeta.always === true || fullMeta?.always === 'true';
      })
      .map((s) => s.name);
  }

  /**
   * 解析技能的 Frontmatter 元数据
   */
  getSkillMetadata(name: string): Record<string, string> | null {
    const content = this.loadSkill(name);
    if (!content?.startsWith('---')) return null;

    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      meta[key] = value;
    }
    return meta;
  }

  /** 获取技能的结构化元数据 */
  private _getSkillMeta(name: string): SkillMeta {
    const fullMeta = this.getSkillMetadata(name);
    return this._parseNanobotMeta(fullMeta?.metadata ?? '');
  }

  /** 解析 nanobot/openclaw 专用元数据字段 */
  private _parseNanobotMeta(raw: string): SkillMeta {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const meta = (parsed['nanobot'] ?? parsed['openclaw'] ?? parsed) as SkillMeta;
      return typeof meta === 'object' && meta !== null ? meta : {};
    } catch {
      return {};
    }
  }

  /**
   * 检查技能依赖是否满足
   * 验证命令行工具和环境变量
   */
  private _checkRequirements(meta: SkillMeta): boolean {
    for (const bin of meta.requires?.bins ?? []) {
      try {
        execSync(`which ${bin}`, { stdio: 'ignore' });
      } catch {
        return false;
      }
    }
    for (const envVar of meta.requires?.env ?? []) {
      if (!process.env[envVar]) return false;
    }
    return true;
  }

  /** 获取缺失的依赖列表（用于显示） */
  private _getMissingRequirements(meta: SkillMeta): string {
    const missing: string[] = [];
    for (const bin of meta.requires?.bins ?? []) {
      try {
        execSync(`which ${bin}`, { stdio: 'ignore' });
      } catch {
        missing.push(`CLI: ${bin}`);
      }
    }
    for (const envVar of meta.requires?.env ?? []) {
      if (!process.env[envVar]) missing.push(`ENV: ${envVar}`);
    }
    return missing.join(', ');
  }

  /** 获取技能描述 */
  private _getSkillDescription(name: string): string {
    const meta = this.getSkillMetadata(name);
    return meta?.description ?? name;
  }

  /** 移除 Frontmatter，返回纯内容 */
  private _stripFrontmatter(content: string): string {
    if (!content.startsWith('---')) return content;
    const match = content.match(/^---\n[\s\S]*?\n---\n/);
    return match ? content.slice(match[0].length).trim() : content;
  }
}
