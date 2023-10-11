import { DebugConfiguration } from "vscode";
import {
  DebugSession,
  InitializedEvent,
  StoppedEvent,
  ContinuedEvent,
  OutputEvent,
  Thread,
  TerminatedEvent,
  ThreadEvent,
  Breakpoint,
  Source,
  StackFrame,
} from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import WebSocket from "ws";
import { NullablePosition, SourceMapConsumer } from "source-map";

export class DebugAdapter extends DebugSession {
  private connection: WebSocket;
  private configuration: DebugConfiguration;
  private threads: Array<Thread> = [];
  private sourceMaps: Array<[string, number, SourceMapConsumer]> = [];
  private stoppedStackFrames: StackFrame[] = [];

  constructor(configuration: DebugConfiguration) {
    super();
    this.configuration = configuration;
    this.connection = new WebSocket(configuration.websocketAddress);

    this.connection.on("open", () => {
      // this.sendEvent(new InitializedEvent());
      // this.connection.send()
      this.sendCDPMessage("Runtime.enable", {});
      this.sendCDPMessage("Debugger.enable", { maxScriptsCacheSize: 100000000 });
      this.sendCDPMessage("Debugger.setPauseOnExceptions", { state: "none" });
      this.sendCDPMessage("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
      this.sendCDPMessage("Debugger.setBlackboxPatterns", { patterns: [] });
      this.sendCDPMessage("Runtime.runIfWaitingForDebugger", {});

      // this.configuration.breakpoints.forEach((breakpoint) => {
      //   this.sendCDPMessage("Debugger.setBreakpointByUrl", {
      //     lineNumber: breakpoint.line,
      //     url: breakpoint.url,
      //     columnNumber: 0,
      //     condition: "",
      //   });
      // });
    });

    this.connection.on("close", () => {
      this.sendEvent(new TerminatedEvent());
    });

    this.connection.on("message", async (data) => {
      const message = JSON.parse(data.toString());
      if (message.result) {
        const resolve = this.cdpMessagePromises.get(message.id);
        this.cdpMessagePromises.delete(message.id);
        if (resolve) {
          resolve(message.result);
        }
        return;
      }
      switch (message.method) {
        case "Runtime.executionContextCreated":
          const context = message.params.context;
          const threadId = context.id;
          const threadName = context.name;
          this.sendEvent(new ThreadEvent("started", threadId));
          this.threads.push(new Thread(threadId, threadName));
          break;
        case "Debugger.scriptParsed":
          const sourceMapURL = message.params.sourceMapURL;
          if (sourceMapURL.startsWith("data:")) {
            const base64Data = sourceMapURL.split(",")[1];
            const decodedData = Buffer.from(base64Data, "base64").toString("utf-8");
            const sourceMap = JSON.parse(decodedData);
            const consumer = await new SourceMapConsumer(sourceMap);
            this.sourceMaps.push([message.params.url, message.params.scriptId, consumer]);
          }
          this.sendEvent(new InitializedEvent());
          break;
        case "Debugger.paused":
          this.handleDebuggerPaused(message);
          break;
        case "Debugger.resumed":
          this.sendEvent(new ContinuedEvent(1));
          break;
        case "Runtime.consoleAPICalled":
          this.sendEvent(
            new OutputEvent(`${message.params.type}: ${message.params.args.join(" ")}`, "console")
          );
          break;
        default:
          break;
      }
    });
  }

  // private async resolveSoyrceLocation(lineNumber: number, columnNumber: number) {
  //   let sourceURL = "";
  //   let sourceLine = lineNumber;
  //   let sourceColumn = columnNumber;
  //   this.sourceMaps.forEach(([url, consumer]) => {
  //     const sources = [];
  //     consumer.eachMapping((mapping) => {
  //       sources.push(mapping.source);
  //     });
  //     const pos = consumer.originalPositionFor({ line: lineNumber, column: columnNumber });
  //     if (pos.line != null) {
  //       sourceURL = consumer.sourceRoot + "/" + pos.source;
  //       sourceLine = pos.line;
  //       sourceColumn = pos.column;
  //     }
  //   });
  //   return { sourceURL, sourceLine, sourceColumn };
  // }
  private findOriginalPosition(scriptId: number, lineNumber: number, columnNumber: number) {
    let scriptURL = "";
    let sourceURL = "";
    let sourceLine = lineNumber;
    let sourceColumn = columnNumber;
    this.sourceMaps.forEach(([url, id, consumer]) => {
      if (id === scriptId) {
        sourceURL = scriptURL = url;

        const pos = consumer.originalPositionFor({ line: lineNumber, column: columnNumber });
        if (pos.source != null) {
          sourceURL = pos.source;
        }
        if (pos.line != null) {
          sourceLine = pos.line;
        }
        if (pos.column != null) {
          sourceColumn = pos.column;
        }
      }
    });
    return { sourceURL, lineNumber: sourceLine, columnNumber: sourceColumn, scriptURL: scriptURL };
  }

  private async handleDebuggerPaused(message: any) {
    this.stoppedStackFrames = message.params.callFrames.map((cdpFrame: any, index: number) => {
      const cdpLocation = cdpFrame.location;
      const { sourceURL, lineNumber, columnNumber, scriptURL } = this.findOriginalPosition(
        cdpLocation.scriptId,
        cdpLocation.lineNumber,
        cdpLocation.columnNumber
      );
      return new StackFrame(
        index,
        cdpFrame.functionName,
        new Source(scriptURL, sourceURL),
        lineNumber,
        columnNumber
      );
    });
    this.sendEvent(new StoppedEvent("breakpoint", this.threads[0].id));
  }

  private cdpMessageId = 0;
  private cdpMessagePromises: Map<number, (result: any) => void> = new Map();

  private async sendCDPMessage(method: string, params: object) {
    const message = {
      id: ++this.cdpMessageId,
      method: method,
      params: params,
    };
    this.connection.send(JSON.stringify(message));
    return new Promise<any>((resolve) => {
      this.cdpMessagePromises.set(message.id, resolve);
    });
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body || {};
    // response.body.supportsConditionalBreakpoints = true;
    // response.body.supportsHitConditionalBreakpoints = true;
    // response.body.supportsFunctionBreakpoints = true;
    this.sendResponse(response);
  }

  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: DebugProtocol.LaunchRequestArguments
  ): void {
    // Implement launching the debugger
    this.sendResponse(response);
  }

  private async setCDPBreakpoint(source: string, line: number, column: number) {
    let position: NullablePosition = { line: null, column: null, lastColumn: null };
    let originalSourceURL: string = "";
    this.sourceMaps.forEach(([sourceURL, scriptId, consumer]) => {
      const sources = [];
      consumer.eachMapping((mapping) => {
        sources.push(mapping.source);
      });
      const pos = consumer.generatedPositionFor({ source, line, column });
      if (pos.line != null) {
        originalSourceURL = sourceURL;
        position = pos;
      }
    });
    if (position.line != null) {
      const result = await this.sendCDPMessage("Debugger.setBreakpointByUrl", {
        lineNumber: position.line,
        url: originalSourceURL,
        columnNumber: position.column,
        condition: "",
      });
      if (result && result.breakpointId !== undefined) {
        return result.breakpointId as number;
      }
    }
    return null;
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    const path = args.source.path as string;

    const actualBreakpoints = (args.breakpoints || []).map(async (bp) => {
      const breakpointId = await this.setCDPBreakpoint(path, bp.line, bp.column || 0);
      if (breakpointId !== null) {
        const actualBreakpoint = new Breakpoint(true, bp.line, bp.column);
        actualBreakpoint.setId(breakpointId);
        return actualBreakpoint;
      } else {
        return new Breakpoint(false, bp.line, bp.column);
      }
    });

    const resolvedBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints);

    // send back the actual breakpoint positions
    response.body = {
      breakpoints: resolvedBreakpoints,
    };
    this.sendResponse(response);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: this.threads,
    };
    this.sendResponse(response);
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    response.body = response.body || {};
    response.body.stackFrames = this.stoppedStackFrames;
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    // Implement getting the scopes
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): void {
    // Implement getting the variables
    this.sendResponse(response);
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): Promise<void> {
    // Implement continuing execution
    await this.sendCDPMessage("Debugger.resume", {});
    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments
  ): void {
    // Implement disconnecting from the debugger
    this.connection.close();
    this.sendResponse(response);
  }
}
