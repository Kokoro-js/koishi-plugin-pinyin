import { Context, h, Logger, Schema, Service } from 'koishi';
import path from 'path';
import { mkdir } from 'fs/promises';
import fs from 'fs';
import { handleFile, DownloadError } from './downloader';

export const name = 'pinyin';
const logger = new Logger(name);

declare module 'koishi' {
  interface Context {
    pinyin: Pinyin;
  }
}

export interface PinyinConvertOptions {
  style?: PINYIN_STYLE;
  heteronym?: boolean;
  segment?: boolean;
}

export const enum PINYIN_STYLE {
  /** 普通风格，不带声调 */
  Plain = 0,
  /** 带声调的风格 */
  WithTone = 1,
  /** 声调在各个拼音之后，使用数字1-4表示的风格 */
  WithToneNum = 2,
  /** 声调在拼音最后，使用数字1-4表示的风格 */
  WithToneNumEnd = 3,
  /** 首字母风格 */
  FirstLetter = 4,
}

export class Pinyin extends Service {
  pinyin: (
    input: string | Buffer,
    opt?: PinyinConvertOptions | undefined | null,
  ) => string[] | string[][];

  asyncPinyin: (
    input: string | Buffer,
    opt?: PinyinConvertOptions | undefined | null,
    signal?: AbortSignal | undefined | null,
  ) => Promise<string[] | string[][]>;
  compare: (inputA: string, inputB: string) => number;
  constructor(
    ctx: Context,
    public config: Pinyin.Config,
  ) {
    super(ctx, 'pinyin');

    ctx
      .command('pinyin <message:string>')
      .option('heteronym', '-d 是否处理多音字', { fallback: false })
      .option(
        'segment',
        '-s 是否开启分词。输入有多音字时，开启分词可以获得更准确结果。',
        { fallback: true },
      )
      .option(
        'output',
        '-o <type:posint> 0 不带声调，1 为带声调(默认），2 为用 1-4 在拼音后标注声调，3 为用 1-4 在所有拼音后标注声调，4 为首字母',
        { fallback: 1 },
      )
      .action(({ options, session }, message) => {
        if (!message) return '你必须提供需要注音的内容';
        const pinyinArray = this.pinyin(message, {
          style: options.output,
          heteronym: options.heteronym,
          segment: options.segment,
        });
        message = pinyinArray
          .map((element) => {
            // 判断元素是数组还是字符串
            if (Array.isArray(element)) {
              // 如果元素是数组，则将数组中的每个元素（字符串）用 "/" 连接起来
              return element.join('/');
            } else {
              // 如果元素是字符串，则直接返回
              return element;
            }
          })
          .join(' ');
        return h('quote', { id: session.messageId }) + message;
      });
  }

  async start() {
    let { nodeBinaryPath } = this.config;
    const nodeDir = path.resolve(this.ctx.baseDir, nodeBinaryPath);
    await mkdir(nodeDir, { recursive: true });
    let nativeBinding = null;
    try {
      nativeBinding = await this.getNativeBinding(nodeDir);
    } catch (e) {
      if (e instanceof UnsupportedError) {
        logger.error('Pinyin 目前不支持你的系统');
      }
      if (e instanceof DownloadError) {
        logger.error('下载二进制文件遇到错误，请查看日志获取更详细信息');
      }
      throw e;
    }
    ({
      pinyin: this.pinyin,
      asyncPinyin: this.asyncPinyin,
      compare: this.compare,
    } = nativeBinding);
    logger.success('Pinyin 服务启动成功');
  }

  private async getNativeBinding(nodeDir) {
    const { platform, arch } = process;
    let nativeBinding;
    let nodeName;

    const platformArchMap = {
      android: {
        arm64: 'pinyin.android-arm64',
        arm: 'pinyin.android-arm-eabi',
      },
      win32: {
        x64: 'pinyin.win32-x64-msvc',
        ia32: 'pinyin.win32-ia32-msvc',
        arm64: 'pinyin.win32-arm64-msvc',
      },
      darwin: {
        x64: 'pinyin.darwin-x64',
        arm64: 'pinyin.darwin-arm64',
      },
      freebsd: {
        x64: 'pinyin.freebsd-x64',
      },
      linux: {
        x64: isMusl() ? 'pinyin.linux-x64-musl' : 'pinyin.linux-x64-gnu',
        arm64: isMusl() ? 'pinyin.linux-arm64-musl' : 'pinyin.linux-arm64-gnu',
        arm: 'pinyin.linux-arm-gnueabihf',
      },
    };
    if (!platformArchMap[platform]) {
      throw new UnsupportedError(
        `Unsupported OS: ${platform}, architecture: ${arch}`,
      );
    }
    if (!platformArchMap[platform][arch]) {
      throw new UnsupportedError(
        `Unsupported architecture on ${platform}: ${arch}`,
      );
    }

    nodeName = platformArchMap[platform][arch];

    const nodeFile = nodeName + '.node';
    const nodePath = path.join(nodeDir, 'package', nodeFile);
    const localFileExisted = fs.existsSync(nodePath);
    try {
      if (!localFileExisted)
        await handleFile(nodeDir, nodeName, logger, this.ctx.http);
      nativeBinding = require(nodePath);
    } catch (e) {
      logger.error('在处理二进制文件时遇到了错误', e);
      if (e instanceof DownloadError) {
        throw e;
      }
      throw new Error(`Failed to use ${nodePath} on ${platform}-${arch}`);
    }
    return nativeBinding;
  }
}

function isMusl() {
  // For Node 10
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      const lddPath = require('child_process')
        .execSync('which ldd')
        .toString()
        .trim();
      return fs.readFileSync(lddPath, 'utf8').includes('musl');
    } catch (e) {
      return true;
    }
  } else {
    const report: { header: any } = process.report.getReport() as unknown as {
      header: any;
    };
    const glibcVersionRuntime = report.header?.glibcVersionRuntime;
    return !glibcVersionRuntime;
  }
}

export namespace Pinyin {
  export interface Config {
    nodeBinaryPath: string;
  }
  export const Config = Schema.object({
    nodeBinaryPath: Schema.path({
      filters: ['directory'],
      allowCreate: true,
    })
      .description('pinyin 二进制文件存放目录')
      .default('node-rs/pinyin'),
  });
}

Context.service('pinyin', Pinyin);
export default Pinyin;
class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}
