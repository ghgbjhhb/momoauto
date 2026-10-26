export interface ImageResponse {
  data: Uint8Array; contentType: string; status: number;
  source?: 'stream'; width?: number; height?: number; decodedAt?: string;
}
export type BinaryResponse = ImageResponse;
export type ManagementRequestOptions = Pick<RequestOptions, 'timeoutMs' | 'signal' | 'headers'>;
export interface ManagementPage<T> { records: T[]; total: number; current?: number; size?: number; pages?: number; raw: unknown }
export interface SortOrder { column: string; asc: boolean }
export interface CloudFile {
  id: string; name: string; url: string; channel?: string; fileType?: string; fileSize?: number;
  appName?: string; packageName?: string; versionName?: string; [field: string]: unknown;
}
export interface CloudListOptions {
  page?: number; size?: number; channel?: '1' | '2'; fileType?: string;
  sort?: 'default' | 'time' | 'size' | 'name'; orders?: SortOrder[]; [filter: string]: unknown;
}
export interface FileUploadOptions extends ManagementRequestOptions {
  fileName: string; fields?: Record<string, unknown>; public?: boolean;
}
export interface FileTypeCount { fileType: string; count: number }
export interface PrivateCloudUsage { fileSizeTotal: number; fileTypeCount: FileTypeCount[]; [field: string]: unknown }
export interface PublicCloudUsage { filePublicSizeTotal: number; filePublicTypeCount: FileTypeCount[]; [field: string]: unknown }
export interface TransferPair { deviceId: string; fileId: string; fileName: string }
export interface TransferStatus {
  finished?: boolean; expired?: boolean; totalCount?: number; successCount?: number; failCount?: number;
  startTime?: string | number; message?: string; details?: Array<Record<string, unknown>>; [field: string]: unknown;
}
export interface VpcConfig {
  id?: string; ip: string; port: string | number; username: string; password: string;
  expTime?: string; userId?: string; groupId?: string; remarks?: string; [field: string]: unknown;
}
export interface VpcRecord extends VpcConfig { id: string }
export interface AddedVpc { vpcId: string; ip: string; port: string; groupId: string; remarks: string; expTime: string }
export interface VpcListOptions {
  current?: number; size?: number; ip?: string; remarks?: string; groupId?: string;
  orders?: SortOrder[]; [filter: string]: unknown;
}
export interface VpcGroup { id: string; name: string; ipCount?: number; [field: string]: unknown }
export interface SpreadsheetQuery {
  current?: number; size?: number; orders?: SortOrder[]; filename?: string; sheetName?: string;
  isHeader?: boolean; original?: boolean; mode?: 'current' | 'selected' | 'all'; selectIds?: string[];
  exportFields?: string[]; [filter: string]: unknown;
}

export class CloudDisk {
  constructor(client: YunmomoClient);
  readonly client: YunmomoClient;
  list(options?: CloudListOptions, requestOptions?: ManagementRequestOptions): Promise<ManagementPage<CloudFile>>;
  get(id: string, options?: ManagementRequestOptions): Promise<CloudFile>;
  usage(channel?: '1', options?: ManagementRequestOptions): Promise<PrivateCloudUsage>;
  usage(channel: '2', options?: ManagementRequestOptions): Promise<PublicCloudUsage>;
  usage(channel: '1' | '2', options?: ManagementRequestOptions): Promise<PrivateCloudUsage | PublicCloudUsage>;
  upload(data: Uint8Array | Blob, options: FileUploadOptions): Promise<any>;
  rename(id: string, name: string, options?: ManagementRequestOptions): Promise<any>;
  delete(ids: string | string[], options?: ManagementRequestOptions): Promise<any>;
  resolveUrl(file: CloudFile | string, options?: ManagementRequestOptions): Promise<string>;
  sendToDevices(deviceIds: string[], files: Array<CloudFile | string>, options: ManagementRequestOptions & {fileType: string}): Promise<any>;
  transferStatus(options?: ManagementRequestOptions): Promise<TransferStatus | null>;
  sendPairs(pairs: TransferPair[], options?: ManagementRequestOptions & {fileType?: string}): Promise<any>;
  pairStatus(options?: ManagementRequestOptions): Promise<TransferStatus | null>;
  clearPairStatus(options?: ManagementRequestOptions): Promise<any>;
  importExcel(data: Uint8Array | Blob, options: Omit<FileUploadOptions, 'public'>): Promise<any>;
  exportExcel(query?: SpreadsheetQuery, options?: ManagementRequestOptions): Promise<BinaryResponse>;
  exportTemplate(options?: ManagementRequestOptions): Promise<BinaryResponse>;
}
export class VpcManager {
  constructor(client: YunmomoClient);
  readonly client: YunmomoClient;
  list(options?: VpcListOptions, requestOptions?: ManagementRequestOptions): Promise<ManagementPage<VpcRecord>>;
  get(id: string, options?: ManagementRequestOptions): Promise<VpcRecord>;
  save(config: VpcConfig, options?: ManagementRequestOptions): Promise<any>;
  batchSave(configs: VpcConfig[], options?: ManagementRequestOptions): Promise<any>;
  addAndGetIds(configs: VpcConfig | VpcConfig[], options?: ManagementRequestOptions & {
    lookupAttempts?: number; lookupIntervalMs?: number;
  }): Promise<{ ids: string[]; results: AddedVpc[]; vpcId?: string }>;
  delete(ids: string | string[], options?: ManagementRequestOptions): Promise<any>;
  testConnection(id: string, options?: ManagementRequestOptions): Promise<boolean>;
  groups(): VpcGroupManager;
  importExcel(data: Uint8Array | Blob, options: Omit<FileUploadOptions, 'public'>): Promise<any>;
  exportExcel(query?: SpreadsheetQuery, options?: ManagementRequestOptions): Promise<BinaryResponse>;
  exportTemplate(options?: ManagementRequestOptions): Promise<BinaryResponse>;
}
export class VpcGroupManager {
  constructor(client: YunmomoClient);
  readonly client: YunmomoClient;
  list(options?: {current?: number; size?: number; [filter: string]: unknown}, requestOptions?: ManagementRequestOptions): Promise<ManagementPage<VpcGroup>>;
  get(id: string, options?: ManagementRequestOptions): Promise<VpcGroup>;
  save(config: {id?: string; name: string}, options?: ManagementRequestOptions): Promise<any>;
  delete(ids: string | string[], options?: ManagementRequestOptions & {mode?: 'keep' | 'delete'}): Promise<any>;
}
export interface RequestOptions {
  method?: string; query?: Record<string, unknown>; body?: unknown;
  headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; responseType?: 'buffer';
}
export interface VideoSettings {
  bitrate?: number; maxFps?: number; iFrameInterval?: number;
  bounds?: { width: number; height: number }; crop?: { left: number; top: number; right: number; bottom: number };
  sendFrameMeta?: boolean; lockedVideoOrientation?: -1 | 0 | 1 | 2 | 3;
  displayId?: number; codecOptions?: string; encoderName?: string;
}
export interface ControlOptions {
  token: string; deviceId: string; udid: string; origin?: string; endpoint?: string;
  screenWidth?: number; screenHeight?: number; displayId?: number; maxFps?: number;
  videoSettings?: VideoSettings; autoRefresh?: boolean; autoCopy?: (text: string) => void | Promise<void>;
}
export interface TouchOptions {
  pointerId?: number; pressure?: number; buttons?: number; screenWidth?: number; screenHeight?: number;
}
export interface GestureOptions extends TouchOptions { durationMs?: number; steps?: number; signal?: AbortSignal }
export interface KeyOptions { repeat?: number; metaState?: number }
export interface ReplyOptions { timeoutMs?: number; signal?: AbortSignal }
export interface ScreenshotOptions extends ReplyOptions {
  source?: 'rest' | 'stream'; level?: 1 | 2;
  /** Stream only. Long-side bound, default 1280; never upscales decoded pixels. */
  maxSize?: number; bitrate?: number; maxAgeMs?: number; udid?: string;
}
export interface DisplayInfo {
  displayId: number; width: number; height: number; rotation: number; layerStack: number; flags: number; connections: number;
  screenInfo?: { videoSize: { width: number; height: number }; deviceRotation: number; contentRect: Record<string, number> };
  videoSettings?: VideoSettings;
}
export interface InitialInfo { deviceName: string; displays: DisplayInfo[]; encoders: string[]; clientId: number }

export class CloudPhoneControl {
  constructor(options: ControlOptions);
  readonly deviceId: string; readonly udid: string;
  connected: boolean; ready: boolean; screenWidth: number; screenHeight: number;
  info: InitialInfo | null; initialFrame: Uint8Array | null; videoSettings: VideoSettings; autoRefresh: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  listenerCount(event: string): number;
  connect(options?: { timeoutMs?: number; waitForInitial?: boolean }): Promise<this>;
  close(options?: { timeoutMs?: number }): Promise<void>;
  refresh(options?: { timeoutMs?: number; waitForInitial?: boolean }): Promise<this>;
  flush(): Promise<this>;
  send(frame: Uint8Array): this;
  buildWebSocketUrl(): string;
  redactedWebSocketUrl(): string;
  toJSON(): Record<string, unknown>;
  tap(x: number, y: number, options?: GestureOptions): Promise<this>;
  longPress(x: number, y: number, options?: GestureOptions): Promise<this>;
  swipe(from: {x: number; y: number}, to: {x: number; y: number}, options?: GestureOptions): Promise<this>;
  touch(action: 0 | 1 | 2, x: number, y: number, options?: TouchOptions): this;
  text(value: string): this;
  keyDown(code: number, options?: KeyOptions): this;
  keyUp(code: number, options?: KeyOptions): this;
  key(code: number, options?: KeyOptions): this;
  pressKey(name: string | number, options?: KeyOptions): this;
  back(options?: KeyOptions): this; home(options?: KeyOptions): this; overview(options?: KeyOptions): this;
  volumeUp(options?: KeyOptions): this; volumeDown(options?: KeyOptions): this;
  scroll(x: number, y: number, options?: TouchOptions & { hScroll?: number; vScroll?: number }): this;
  command(type: number): this; backOrScreenOn(): this;
  expandNotifications(): this; expandSettings(): this; collapsePanels(): this; rotate(): this;
  screenPower(on: boolean): this;
  getClipboard(options?: ReplyOptions): Promise<string>;
  setClipboard(text: string, options?: { paste?: boolean }): this;
  paste(text: string): this;
  setVideoSettings(options: VideoSettings): this;
  setStreamSize(size: number): this;
  setAutoRefresh(enabled: boolean, options?: { delays?: number[] }): this;
  setAutoCopy(handler: false | ((text: string) => void | Promise<void>)): this;
  pushFile(source: string | Uint8Array, options?: ReplyOptions & { fileName?: string; chunkSize?: number }):
    Promise<{ id: number; fileName: string; bytes: number; acknowledged: true }>;
}

export class YunmomoHttpError extends Error {
  constructor(message: string, status: number, data: unknown);
  readonly status: number; readonly data: unknown;
}
export class YunmomoClient {
  constructor(options?: { baseUrl?: string; token?: string; timeoutMs?: number; fetchImpl?: typeof fetch });
  token: string; baseUrl: string; timeoutMs: number;
  request(path: string, options: RequestOptions & { responseType: 'buffer' }): Promise<ImageResponse>;
  request(path: string, options?: RequestOptions): Promise<any>;
  invoke(action: string, payload?: Record<string, unknown>, options?: RequestOptions): Promise<any>;
  listDevices(options?: { current?: number; size?: number; filters?: Record<string, unknown> }):
    Promise<{ records: Array<Record<string, any>>; total: number; raw: unknown }>;
  getDevice(id: string, options?: ReplyOptions): Promise<any>;
  listModels(): Promise<{ records: Array<{ id: number | string; name: string; androidVersion: string | number;
    [key: string]: unknown }>; raw: unknown }>;
  screenshot(id: string, options?: ScreenshotOptions): Promise<ImageResponse>;
  closeScreenshots(): Promise<void>;
  openControl(options: Omit<ControlOptions, 'token'>): CloudPhoneControl;
  device(id: string): CloudPhoneDevice;
  cloudDisk(): CloudDisk;
  vpc(): VpcManager;
  uploadCloudFile(data: Uint8Array, options: { fileName: string; fields?: Record<string, unknown>; timeoutMs?: number }): Promise<any>;
  uploadGoogleCertificate(ids: string[], data: Uint8Array, options: { fileName: string; timeoutMs?: number }): Promise<any>;
  sendFiles(ids: string[], urls: string[], options: { fileType: string }): Promise<any>;
}
export class CloudPhoneDevice {
  constructor(client: YunmomoClient, deviceId: string);
  readonly client: YunmomoClient; readonly deviceId: string;
  getInfo(options?: ReplyOptions): Promise<any>; screenshot(options?: ScreenshotOptions): Promise<ImageResponse>;
  tools(options?: DeviceToolsOptions): CloudPhoneTools;
  invoke(action: string, fields?: Record<string, unknown>, options?: RequestOptions): Promise<any>;
  start(): Promise<any>; stop(): Promise<any>; reboot(containerId: string): Promise<any>;
  rename(name: string): Promise<any>; reset(): Promise<any>; resetV3(countryCode: string): Promise<any>;
  countryCodes(): Promise<any>;
  switchModel(config: { modelId: number | string; modelName: string; resetData?: boolean; countryCode?: string },
    options?: RequestOptions): Promise<any>;
  randomDeviceInfo(): Promise<any>; randomFingerprint(): Promise<any>; restartVpc(): Promise<any>;
  listFiles(path?: string): Promise<any>; downloadFile(path: string): Promise<ImageResponse>;
  playAudio(path: string): Promise<any>; stopAudio(path: string): Promise<any>;
  getProxy(version?: 'legacy' | 'v1'): Promise<any>; stopProxy(version?: 'legacy' | 'v1'): Promise<any>;
  setProxy(config: { s5ip: string; s5port: number; s5user?: string; s5pwd?: string; domainMode?: string;
    proxyMode?: string; expTime?: string }, version?: 'legacy' | 'v1'): Promise<any>;
  setDeviceInfo(config: { devinfo: string | object; brand?: string; marketName?: string; model?: string; androidVersion?: string }): Promise<any>;
  uploadGoogleCertificate(data: Uint8Array, options: { fileName: string; timeoutMs?: number }): Promise<any>;
  sendFiles(urls: string[], options: { fileType: string }): Promise<any>;
  openControl(options?: Partial<Omit<ControlOptions, 'token' | 'deviceId'>>): Promise<CloudPhoneControl>;
}
export interface PixelSize { width: number; height: number }
export interface ToolExecution {
  state: 'not_started' | 'partial' | 'sent'; framesSent: number; completedClicks: number;
  release: 'not_needed' | 'pending' | 'sent' | 'failed' | 'connection_lost';
  localWriteConfirmed: boolean; deviceConfirmed: false;
}
export interface ToolError {
  code: string; message: string; stage: string; details: Record<string, unknown>;
  retrySafe: boolean; retryable: boolean;
}
export interface ToolResultBase {
  operation: 'screenshot' | 'click' | 'clickRegion' | 'swipe' | 'openMomo' | 'sendContact' | 'blockPeer' | 'refreshMomoHome' | 'browseMomoHome'; operationId: string; deviceId: string;
  startedAt: string; durationMs: number; attempts: number; execution: ToolExecution; warnings?: string[];
}
export type ToolResult<T, S extends 'captured' | 'planned' | 'sent' | 'opened'> = ToolResultBase & (
  { ok: true; status: S; data: T; error: null } |
  { ok: false; status: 'failed'; data: T | null; error: ToolError }
);
export type ToolLogEntry = Omit<ToolResultBase, 'warnings'> & {
  status: 'captured' | 'planned' | 'sent' | 'opened' | 'failed'; ok: boolean;
  error: Pick<ToolError, 'code' | 'stage' | 'retrySafe' | 'retryable'> | null;
};
export interface DeviceToolsOptions {
  control?: CloudPhoneControl; udid?: string; timeoutMs?: number; connectTimeoutMs?: number;
  dryRun?: boolean; screenSize?: PixelSize;
  momoVision?: MomoVisionOptions;
  /** Borrowed application-owned GPU pool. tools.close() does not close this pool. */
  recognitionPool?: GpuRecognitionPool | SharedRecognitionClient;
  /** Synchronous metadata callback. Image bytes and credentials are never included. */
  logger?: (entry: ToolLogEntry) => void;
}
export interface ScreenshotToolOptions extends ReplyOptions {
  level?: 1 | 2; attempts?: number; retryDelayMs?: number; maxBytes?: number;
  source?: 'rest' | 'stream'; maxSize?: number; bitrate?: number; maxAgeMs?: number;
}
export interface ScreenshotToolData {
  image: Uint8Array; format: 'png' | 'jpeg'; mimeType: 'image/png' | 'image/jpeg';
  width: number; height: number; bytes: number; httpStatus: number; capturedAt: string;
  source: 'rest' | 'stream'; decodedAt?: string;
}
export interface CoordinateToolOptions extends ReplyOptions {
  dryRun?: boolean; coordinateSpace?: PixelSize; offset?: {x?: number; y?: number}; jitterPx?: number;
}
export interface ClickToolOptions extends CoordinateToolOptions {
  button?: 'left'; count?: 1 | 2 | 3; holdMs?: number | {min: number; max: number}; intervalMs?: number;
}
export interface ClickToolData {
  coordinateSpace: PixelSize; screenSize: PixelSize; button: 'left'; count: number;
  intervalMs: number; durationMs: number; clicks: Array<{x: number; y: number; holdMs: number}>;
}
export interface RegionClickOptions extends ReplyOptions {
  dryRun?: boolean; coordinateSpace?: PixelSize; holdMs?: number | {min: number; max: number};
  /** Central rectangle width/height relative to the inset target, defaults to .4. */
  centerFraction?: number;
  /** Probability of sampling the central rectangle; remaining probability samples only the outer ring. */
  centerProbability?: number; insetPx?: number;
}
export interface WeightedTarget {
  x: number; y: number; region: 'center' | 'outer';
  box: number[]; safeBox: number[]; centerBox: number[];
  centerFraction: number; centerProbability: number; insetPx: number;
}
export interface RegionClickData extends ClickToolData { target: WeightedTarget }
export interface SwipePoint { x: number; y: number; pauseMs?: number }
export interface SwipeToolOptions extends CoordinateToolOptions {
  durationMs?: number; segmentDurationsMs?: number[]; stepMs?: number;
  startHoldMs?: number; endHoldMs?: number; easing?: 'linear' | 'easeInOut';
}
export interface SwipeToolData {
  coordinateSpace: PixelSize; screenSize: PixelSize; points: Array<Required<SwipePoint>>;
  durationMs: number; segmentDurationsMs: number[]; stepMs: number; startHoldMs: number;
  endHoldMs: number; easing: 'linear' | 'easeInOut'; moveCount: number;
}
export interface MomoVisionOptions {
  runtime?: 'wsl' | 'native'; pythonPath?: string; distribution?: string; device?: 'cuda:0' | 'cpu';
  manifestPath?: string; listWeights?: string; detailWeights?: string;
}
export interface OpenMomoOptions extends ReplyOptions {
  dryRun?: boolean; maxPagesPerDirection?: number; pollMs?: number; homeTimeoutMs?: number;
  launchTimeoutMs?: number; stableObservations?: number; confidence?: number;
  iconThreshold?: number; anchorThreshold?: number;
}
export interface MomoTemplateMatch {
  id: string; role: 'app_icon' | 'home_anchor' | 'dock_anchor' | 'login' | 'permission' | 'update' | 'blocked';
  confidence: number; box: [number, number, number, number];
}
export interface MomoScene {
  page: 'message_list' | 'chat_detail' | 'momo_main'; confidence: number;
  anchors: Array<{class: string; confidence: number; box: number[]}>;
}
export interface MomoObservation {
  width: number; height: number; homeConfirmed: boolean; launcher: boolean;
  icons: MomoTemplateMatch[]; homeAnchors: MomoTemplateMatch[]; dockAnchors: MomoTemplateMatch[];
  blocked: MomoTemplateMatch | null; modal: boolean; scene: MomoScene | null;
  fingerprint: string; elapsedMs: number;
}
export interface OpenMomoReport {
  app: 'momo'; alreadyOpen: boolean; page: 'unknown' | MomoScene['page']; pageConfirmed: boolean;
  verifiedBy: 'yolo_scene_signature' | null; screenshots: number; homeKeysSent: number; pagesVisited: number;
  iconClickAttempted: boolean; iconClickSent: boolean; lastScreenshot: ScreenshotToolData | null;
  lastObservation: MomoObservation | null; history: Array<{stage: string; elapsedMs: number; [key: string]: unknown}>;
  vision: {device: string; gpu: string | null; classes: Array<Record<string, string>>; templateCount: number; opencv: string; torch: string} | null;
}
export interface OpenMomoPlan {
  app: 'momo'; settings: Required<Omit<OpenMomoOptions, 'signal' | 'timeoutMs'>>; steps: string[]; note: string;
}
export interface SendContactOptions extends ReplyOptions {
  /** Defaults to false. Real messages require execute:true and dryRun:false. */
  execute?: boolean; dryRun?: boolean; introText?: string; python?: string;
  keyIntervalMs?: number; settleMs?: number; messageIntervalMs?: number; pollMs?: number;
  keyboardTimeoutMs?: number; sendTimeoutMs?: number; confidence?: number; minimumScore?: number;
  candidateRoi?: [number, number, number, number]; emptyLabels?: string[];
}
export interface SendContactPlan {
  messages: string[]; split: '3+3+remainder'; execute: false; steps: string[];
}
export interface ChatDetailObservation {
  width: number; height: number; resolution: [number, number]; is_occluded: boolean;
  elements: Record<string, {class: string; label: string; confidence: number; box: number[]; center: number[]}>;
  all_detections: Array<{class: string; confidence: number; box: number[]; center: number[]}>;
  avatars: Array<{class: 'avatar'; confidence: number; box: number[]; center: number[]}>;
  bubbleRegions: Array<{id: string; color: 'pink' | 'white'; sender: 'peer' | 'self'; confidence: number; box: number[]; center: number[]}>;
  headerSignature: number[]; elapsedMs: number; occlusion_info: unknown;
  assistant_overlay_candidate?: {panel_detected: boolean; close_x_detected: boolean; confirmed: boolean};
}
export interface SendContactReport {
  messages: Array<{index: number; text: string; state: 'pending' | 'typing' | 'draft_verified' | 'send_attempted' | 'input_cleared'}>;
  completedMessages: number; uncertainMessageIndex: number | null; screenshots: number; inputClicks: number;
  keyboard: 'unknown' | 'open' | 'closed' | 'ambiguous'; completion: 'not_started' | 'ui_input_cleared';
  lastScreenshot: ScreenshotToolData | null; lastObservation: ChatDetailObservation | null;
  vision: {device: string; gpu: string | null; classes: string[]; model: string} | null;
  history: Array<{stage: string; elapsedMs: number; [key: string]: unknown}>;
}
export interface BlockPeerOptions extends ReplyOptions {
  /** Preview by default; blocking requires execute:true and dryRun:false. */
  execute?: boolean; dryRun?: boolean; confidence?: number; minimumScore?: number;
  pollMs?: number; stepTimeoutMs?: number; stableObservations?: number;
}
export interface BlockPeerPlan {
  app: 'momo'; execute: false; avatarSelection: 'model2_topmost_header_avatar_only'; steps: string[]; note: string;
}
export interface BlockPeerReport {
  avatarClickAttempted: boolean; avatarClickSent: boolean; menuClickAttempted: boolean; menuClickSent: boolean;
  confirmationClickAttempted: boolean; confirmationClickSent: boolean;
  /** True only when an existing blocked-state UI was observed, not inferred from a click. */
  blockedUiConfirmed: boolean;
  outcome: 'not_started' | 'unknown_after_confirm' | 'confirmation_clicked' | 'already_blocked_ui'; screenshots: number;
  avatar: {box: number[]; x: number; y: number; confidence: number} | null;
  lastScreenshot: ScreenshotToolData | null; lastObservation: Record<string, unknown> | null;
  history: Array<{stage: string; elapsedMs: number; [key: string]: unknown}>;
  vision: SendContactReport['vision'];
}
export interface IntegerRange { min: number; max: number }
export interface RefreshMomoHomeOptions extends ReplyOptions {
  /** Preview by default. Real touch input requires execute:true and dryRun:false. */
  execute?: boolean; dryRun?: boolean; mode?: 'random' | 'button' | 'pull';
  buttonProbability?: number; centerFraction?: number; centerProbability?: number; insetPx?: number;
  /** Reset to the top via the home button before a pull when position is unknown/scrolled. */
  resetBeforePull?: boolean; confidence?: number; pollMs?: number; stepTimeoutMs?: number;
  stableObservations?: number; settleMs?: number; swipeDurationMs?: IntegerRange;
}
export interface BrowseMomoHomeOptions extends RefreshMomoHomeOptions {
  cycles?: number; refreshCount?: IntegerRange; scrollCount?: IntegerRange; scrollIntervalMs?: IntegerRange;
}
export interface MomoHomeSettings {
  execute: boolean; dryRun: boolean; mode: 'random' | 'button' | 'pull'; buttonProbability: number;
  centerFraction: number; centerProbability: number; insetPx: number; resetBeforePull: boolean;
  confidence: number; pollMs: number; stepTimeoutMs: number; stableObservations: number; settleMs: number;
  swipeDurationMs: IntegerRange; cycles?: number; refreshCount?: IntegerRange; scrollCount?: IntegerRange; scrollIntervalMs?: IntegerRange;
}
export interface MomoHomePlan {
  app: 'momo'; description: string; execute: false; settings: MomoHomeSettings; steps: string[]; note: string;
}
export interface MomoHomeCycle {
  index: number; refreshTarget: number; scrollTarget: number; refreshesSent: number; scrollsSent: number;
  methods: Array<'button' | 'pull'>; waitsMs: number[]; completed: boolean;
}
export interface MomoHomeReport {
  app: 'momo'; description: string; settings: MomoHomeSettings;
  outcome: 'not_started' | 'running' | 'stopped' | 'refresh_sent_home_reconfirmed' | 'cycles_completed_home_reconfirmed';
  requestedCycles: number; completedCycles: number; refreshesSent: number; buttonRefreshesSent: number;
  pullRefreshesSent: number; scrollsSent: number; topResetsSent: number; method?: 'button' | 'pull';
  homeConfirmed: boolean; refreshContentConfirmed: false; screenshots: number; cycles: MomoHomeCycle[];
  pendingAction: {role: string; kind: string} | null; lastScreenshot: ScreenshotToolData | null;
  lastObservation: {page: MomoPageObservation; tabs?: ChatListDetection[];
    workers: Record<string, RecognitionResult<unknown>['worker']>; timings: Record<string, RecognitionTimings>} | null;
  history: Array<{stage: string; elapsedMs: number; [key: string]: unknown}>;
}
export interface MomoGreetingsOptions extends ReplyOptions {
  execute?: boolean; dryRun?: boolean; maxApproved?: number;
  approveProbability?: number; rejectProbability?: number; cycles?: number;
  cycleIntervalMinutes?: {min: number; max: number}; cardWaitMs?: {min: number; max: number};
  stepTimeoutMs?: number; settleMs?: number; pollMs?: number;
  centerFraction?: number; centerProbability?: number; insetPx?: number;
}
export interface MomoContactSyncOptions extends ReplyOptions {
  execute?: boolean; dryRun?: boolean; boundaryStableCount?: number;
  settleMs?: number; scrollSettleMs?: number; swipeDurationMs?: number; pollMs?: number; dbPath?: string;
  /** Every screenshot and recognition decision is archived; omitted creates a run directory. */
  screenshotsDir?: string;
  /** Contact name supplied by the caller when the device is already on that chat page. */
  contactName: string;
  /** Compatibility marker; this workflow always processes only the current chat. */
  currentChatOnly?: true;
}
export interface MomoWorkflowPlan {
  app: 'momo'; action: 'greetings' | 'contact_sync'; description: string; execute: false;
  settings: Record<string, unknown>; steps: string[]; note: string;
  database?: {path: string; cachedContactCount: number; sampleContacts: string[]};
}
export interface MomoGreetingsReport {
  app: 'momo'; action: 'greetings'; description: string; settings: Record<string, unknown>;
  outcome: 'not_started' | 'running' | 'completed' | 'rate_limited' | 'stopped';
  requestedCycles: number; completedCycles: number; totalApproved: number; totalRejected: number;
  rateLimited: boolean;
  cycles: Array<{cycle: number; approved: number; rejected: number; outcome: string;
    waitedNextCycleMs: number; decisions: Array<{decision: 'approve' | 'reject'; box: number[]; timestamp: string}>}>;
  screenshots: number; lastScreenshot: ScreenshotToolData | null; lastObservation: Record<string, unknown> | null;
  history: Array<{stage: string; elapsedMs: number; [key: string]: unknown}>;
}
export interface MomoContactSyncReport {
  app: 'momo'; action: 'contact_sync'; description: string; settings: Record<string, unknown>;
  databasePath: string; outcome: 'not_started' | 'running' | 'completed' | 'stopped';
  contactsProcessed: number; newContactsAdded: number; totalMessagesCollected: number;
  totalMessagesAlreadyStored: number; totalMessagesIngested: number;
  version: 2; collectionScope: 'verified_bottom_to_history_top'; startMode: 'current_chat';
  collectedMessages: Array<{sender: 'peer' | 'self'; text: string}>;
  frames: Array<Record<string, unknown>>;
  currentContact: {name: string; topConfirmed: boolean; bottomConfirmed: boolean; messagesCollected: number} | null;
  details: Array<{contactName: string; messagesCount: number; savedCount: number;
    peerMessages: number; selfMessages: number; systemMessages: number}>;
  screenshots: number; screenshotsDirectory: string | null;
  savedScreenshots: Array<{index: number; purpose: string; imagePath: string; format: 'png' | 'jpeg';
    mimeType: 'image/png' | 'image/jpeg'; width: number; height: number; bytes: number;
    source: 'rest' | 'stream'; capturedAt: string}>;
  lastScreenshot: ScreenshotToolData | null;
  history: Array<{stage: string; elapsedMs: number; [key: string]: unknown}>;
}

export type MessageListUnreadState = 'none' | 'known' | 'unknown';
export interface MessageListUnreadEvidence {
  type: 'model_badge' | 'ocr_badge'; box: number[]; confidence: number | null;
}
export interface MessageListCandidate {
  peerName: string; box: number[]; center: number[]; unreadCount: number | null;
  hasUnread: boolean; unreadState: MessageListUnreadState;
  unreadEvidence: MessageListUnreadEvidence | null; lastMessage: string; confidence: number;
}
export interface MessageListScan {
  isOnMatchTab: boolean; isConfirmedMessageList: boolean; confirmationMode?: string;
  msgTopTabBox: number[] | null; candidates: MessageListCandidate[]; totalFound: number; timestamp: number;
}
export interface MessageWatchActionContext {
  deviceId: string; peerName: string; candidate: MessageListCandidate;
  observation: Record<string, unknown>; scan: MessageListScan;
  tools: CloudPhoneTools | null; control: CloudPhoneControl | null;
  assertTargetPage(): Promise<MessageWatchActionContext>;
}
export interface MessageListContactActionContext {
  type: 'unread_contact_opened' | 'unregistered_contact_opened'; deviceId: string; peerName: string;
  contactName: string;
  candidate: MessageListCandidate;
  listObservation: Record<string, unknown>; detailObservation: Record<string, unknown>;
  client: YunmomoClient | null; tools: CloudPhoneTools | null; control: CloudPhoneControl | null; signal?: AbortSignal;
  leaseToken: string | null; assertActive(): void;
  isUnread: boolean; isUnregistered: boolean;
  contactRecord: Record<string, unknown> | null; dbPath: string | null;
  contactSyncOptions: Record<string, unknown>; aiReplyOptions: Record<string, unknown>;
  assertChatDetail(): Promise<Record<string, unknown>>;
}
export interface MessageListDrainOptions extends ReplyOptions {
  execute?: boolean; maxPages?: number; maxRounds?: number; maxContacts?: number;
  settleMs?: number; swipeDurationMs?: number; stopOnActionError?: boolean;
  includeUnregistered?: boolean; dbPath?: string;
}
export interface MessageWatchEvent {
  type: 'baseline_unread' | 'new_unread' | 'unread_changed'; peerName: string;
  candidate: MessageListCandidate; previous: MessageListCandidate | null;
  snapshotId?: string; capturedAt?: string; generation?: number; detectedAt: string;
  withTargetPage(action: (context: MessageWatchActionContext) => unknown | Promise<unknown>): Promise<unknown>;
}
export interface MessageListWatcherOptions {
  client?: YunmomoClient; tools?: CloudPhoneTools; control?: CloudPhoneControl; deviceId: string;
  intervalMs?: number; timeoutMs?: number; baselineMode?: 'skip' | 'process'; missingScansToClear?: number;
  onlyContacts?: string[]; ownerId?: string; arbiter?: unknown; lease?: unknown;
  onUnread?: (event: MessageWatchEvent) => unknown | Promise<unknown>;
  onContact?: (context: MessageListContactActionContext) => unknown | Promise<unknown>;
  onUnregisteredContact?: (context: MessageListContactActionContext) => unknown | Promise<unknown>;
  includeUnregistered?: boolean; dbPath?: string;
  contactLookup?: (peerName: string) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  contactSyncOptions?: Record<string, unknown>;
  aiReplyOptions?: Record<string, unknown>;
  onState?: (state: Record<string, unknown>) => unknown | Promise<unknown>;
}
export class MomoMessageListWatcher {
  constructor(options: MessageListWatcherOptions);
  observeTargetPage(options?: ReplyOptions): Promise<Record<string, unknown>>;
  pollOnce(options?: ReplyOptions): Promise<Record<string, unknown>>;
  run(options?: ReplyOptions & {maxIterations?: number}): Promise<Record<string, unknown>>;
  drainUnread(options?: MessageListDrainOptions): Promise<Record<string, unknown>>;
  runDrainLoop(options?: MessageListDrainOptions & {maxIterations?: number}): Promise<Record<string, unknown>>;
  runWithTargetPage(peerName: string, action: (context: MessageWatchActionContext) => unknown | Promise<unknown>, options?: ReplyOptions): Promise<unknown>;
  close(): Promise<void>;
}
export function createMessageListWatcher(options: MessageListWatcherOptions): MomoMessageListWatcher;

export class CloudPhoneTools {
  constructor(device: CloudPhoneDevice, options?: DeviceToolsOptions);
  readonly deviceId: string;
  screenshot(options?: ScreenshotToolOptions): Promise<ToolResult<ScreenshotToolData, 'captured'>>;
  click(x: number, y: number, options?: ClickToolOptions): Promise<ToolResult<ClickToolData, 'sent' | 'planned'>>;
  /** Sample one click inside a current detection rectangle; does not perform detection itself. */
  clickRegion(box: [number, number, number, number], options?: RegionClickOptions): Promise<ToolResult<RegionClickData, 'sent' | 'planned'>>;
  swipe(points: SwipePoint[], options?: SwipeToolOptions): Promise<ToolResult<SwipeToolData, 'sent' | 'planned'>>;
  openMomo(options?: OpenMomoOptions): Promise<ToolResult<OpenMomoReport, 'opened'> | ToolResult<OpenMomoPlan, 'planned'>>;
  /** Current chat only; preview by default. Never automatically retries a Send. */
  sendContact(contact: string, options?: SendContactOptions): Promise<ToolResult<SendContactReport, 'sent'> | ToolResult<SendContactPlan, 'planned'>>;
  /** Current chat only; model 2 selects the topmost header avatar. Completes after the final dialog click is written. */
  blockPeer(options?: BlockPeerOptions): Promise<ToolResult<BlockPeerReport, 'sent'> | ToolResult<BlockPeerPlan, 'planned'>>;
  /** Current home feed only. Default preview, no navigation from another page. */
  refreshMomoHome(options?: RefreshMomoHomeOptions): Promise<ToolResult<MomoHomeReport, 'sent'> | ToolResult<MomoHomePlan, 'planned'>>;
  /** Bounded refresh/browse cycles. Cancels via signal, with partial progress in data. */
  browseMomoHome(options?: BrowseMomoHomeOptions): Promise<ToolResult<MomoHomeReport, 'sent'> | ToolResult<MomoHomePlan, 'planned'>>;
  /** One cycle by default. Rate limiting ends this invocation; the caller decides when to retry. */
  processMomoGreetings(options?: MomoGreetingsOptions): Promise<ToolResult<MomoGreetingsReport, 'sent'> | ToolResult<MomoWorkflowPlan, 'planned'>>;
  /** Device-local SQLite. Commits only after confirming the chat page and both history boundaries. */
  syncMomoContacts(options: MomoContactSyncOptions): Promise<ToolResult<MomoContactSyncReport, 'sent'> | ToolResult<MomoWorkflowPlan, 'planned'>>;
  /** Cancels work and releases owned control/clients; never stops a borrowed or shared recognition service. */
  close(): Promise<void>;
}
export function createDeviceTools(device: CloudPhoneDevice, options?: DeviceToolsOptions): CloudPhoneTools;

export type RecognitionModel = 'chatList' | 'chatDetail' | 'page' | 'ocr';
export interface RecognitionOptions extends ReplyOptions {}
export interface ChatDetailRecognitionOptions extends RecognitionOptions { confidence?: number }
export interface ChatListRecognitionOptions extends ChatDetailRecognitionOptions {
  filterEdgeCards?: boolean; returnAllWithStatus?: boolean;
}
export interface OcrRecognitionOptions extends RecognitionOptions {
  mode?: 'general' | 'ime';
  /** Optional general-OCR crops; normalized boxes, at most eight. Coordinates in results remain full-frame. */
  regions?: Array<[number, number, number, number]>;
  input_roi?: [number, number, number, number];
  input_full_roi?: [number, number, number, number];
  candidate_roi?: [number, number, number, number];
  full_field?: boolean; detected_candidates?: boolean;
}
export interface OcrTextItem {
  text: string; score: number; left: number; top: number; right: number; bottom: number;
  center_x: number; center_y: number; source?: string;
}
export interface OcrObservation {
  ok: true; width: number; height: number; elapsedMs: number;
  items?: OcrTextItem[];
  keyboardSwitches?: Array<{text: string; state: 'on' | 'off' | 'unknown'; centerX: number; centerY: number; colorFraction: number; source: string}>;
  mapVision?: {rendered: boolean; edgeFraction: number; roadFraction: number; marker: {x: number; y: number} | null; fingerprint: number[]} | null;
  elapsed?: Array<number | null>;
  candidates?: OcrTextItem[]; input_text?: string; input_scores?: number[]; elapsed_ms?: number;
}
export interface RecognitionFailureInfo {
  code: string; message: string; stage: string; details: Record<string, unknown>;
}
export interface RecognitionTimings {
  queueMs: number; processingMs: number | null; decodeMs: number | null;
  predictMs: number | null; totalMs: number;
}
export type RecognitionResult<T> = {
  requestId: string; model: RecognitionModel; timings: RecognitionTimings;
  worker: {lane: number; device: 'cuda:0'; pid: number | null} | null;
} & ({ok: true; status: 'recognized'; data: T; error: null} |
  {ok: false; status: 'failed'; data: null; error: RecognitionFailureInfo});
export interface ChatListDetection {
  class: string; confidence: number; box: number[]; center: number[]; area: number;
}
export interface ChatListObservation {
  width: number; height: number; resolution: [number, number]; elapsedMs: number;
  tab_top_y: number; header_bottom_y: number; total_detections: number;
  chat_cards: Array<ChatListDetection & {height: number; is_edge: boolean; edge_reason: string | null}>;
  other_elements: ChatListDetection[];
}
export interface MomoPageObservation {
  width: number; height: number; elapsedMs: number;
  page_level: '1级页面' | '2级消息页' | '可能不在momoapp';
  sub_page: '首页' | '消息列表' | '未知1级页面' | '聊天详情页' | null; is_momo: boolean;
  confidence?: {has_input_box: boolean; has_back_btn: boolean};
  matched_tabs?: string[]; top_keywords?: string[];
}
export interface RecognitionDataMap {
  chatList: ChatListObservation; chatDetail: ChatDetailObservation; page: MomoPageObservation; ocr: OcrObservation;
}
export interface RecognitionRequestMap {
  chatList: ChatListRecognitionOptions; chatDetail: ChatDetailRecognitionOptions; page: RecognitionOptions; ocr: OcrRecognitionOptions;
}
export interface RecognitionLaneInfo {
  lane: number; device: 'cuda:0'; classes: string[]; warmupMs: number;
  ocr?: {
    detProvider: 'CUDAExecutionProvider'; recProvider: 'CUDAExecutionProvider';
    clsProvider?: 'CUDAExecutionProvider'; implementation?: 'legacy-ppocr-v3';
    directionClassifier: boolean; limitType: 'max' | 'min'; cudnnSearch: 'HEURISTIC';
    warmup?: Array<{width: number; height: number; recognized: true}>;
  };
}
export interface RecognitionPoolInfo {
  ready: true; device: 'cuda:0'; gpu: string; pid: number; startupMs: number;
  warmupSizes: Array<[number, number]>; maxInFlight: number;
  models: Record<RecognitionModel, {workers: number; lanes: RecognitionLaneInfo[]}>;
}
export interface RecognitionLogEntry {
  event: string; requestId: string | null; model: RecognitionModel | null;
  lane: number | null; queued: number | null; active: number;
  ok?: boolean; timings?: RecognitionTimings;
  error?: Pick<RecognitionFailureInfo, 'code' | 'stage'> | null;
}
export interface RecognitionPoolOptions {
  runtime?: 'wsl' | 'native'; pythonPath?: string; distribution?: string;
  listWeights?: string; detailWeights?: string;
  workers?: Partial<Record<RecognitionModel, number>>;
  maxInFlight?: number; maxQueueSize?: number; maxPendingBytes?: number;
  timeoutMs?: number; startupTimeoutMs?: number; warmupSizes?: Array<[number, number]>;
  logger?: (entry: RecognitionLogEntry) => void | Promise<void>;
}
export interface RecognitionPoolStatus {
  state: 'idle' | 'starting' | 'ready' | 'draining' | 'closing' | 'closed' | 'failed';
  ready: boolean; accepting: boolean; active: number; pending: number; pendingBytes: number;
  maxInFlight: number; maxQueueSize: number; maxPendingBytes: number;
  models: Record<RecognitionModel, {workers: number; active: number; queued: number}>;
  metrics: {admitted: number; completed: number; failed: number; rejected: number; discardedLateResults: number};
  lastError: RecognitionFailureInfo | null; info: RecognitionPoolInfo | null;
}
export class RecognitionError extends Error {
  constructor(code: string, message: string, stage?: string, details?: Record<string, unknown>);
  readonly code: string; readonly stage: string; readonly details: Record<string, unknown>;
}
export class GpuRecognitionPool {
  constructor(options?: RecognitionPoolOptions);
  readonly closed: boolean; readonly info: RecognitionPoolInfo | null;
  start(): Promise<RecognitionPoolInfo>;
  recognize<M extends RecognitionModel>(model: M, image: Uint8Array, options?: RecognitionRequestMap[M]):
    Promise<RecognitionResult<RecognitionDataMap[M]>>;
  chatList(image: Uint8Array, options?: ChatListRecognitionOptions): Promise<RecognitionResult<ChatListObservation>>;
  chatDetail(image: Uint8Array, options?: ChatDetailRecognitionOptions): Promise<RecognitionResult<ChatDetailObservation>>;
  page(image: Uint8Array, options?: RecognitionOptions): Promise<RecognitionResult<MomoPageObservation>>;
  ocr(image: Uint8Array, options?: OcrRecognitionOptions): Promise<RecognitionResult<OcrObservation>>;
  status(): RecognitionPoolStatus;
  close(options?: {drain?: boolean; timeoutMs?: number}): Promise<void>;
}
export function createRecognitionPool(options?: RecognitionPoolOptions): GpuRecognitionPool;

/** Project-wide loopback service; closing this borrower never stops other devices. */
export class SharedRecognitionClient {
  readonly closed: boolean; readonly info: RecognitionPoolInfo | null;
  start(): Promise<RecognitionPoolInfo>;
  recognize<M extends RecognitionModel>(model: M, image: Uint8Array, options?: RecognitionRequestMap[M]): Promise<RecognitionResult<RecognitionDataMap[M]>>;
  chatList(image: Uint8Array, options?: ChatListRecognitionOptions): Promise<RecognitionResult<ChatListObservation>>;
  chatDetail(image: Uint8Array, options?: ChatDetailRecognitionOptions): Promise<RecognitionResult<ChatDetailObservation>>;
  page(image: Uint8Array, options?: RecognitionOptions): Promise<RecognitionResult<MomoPageObservation>>;
  ocr(image: Uint8Array, options?: OcrRecognitionOptions): Promise<RecognitionResult<OcrObservation>>;
  status(): Promise<RecognitionPoolStatus & {launcherVision: {queuedOrActive: number; resident: boolean; info: unknown}}>;
  close(): Promise<void>;
}

export class CloudPhoneBrowserView {
  constructor(page: any, options: { udid: string });
  setPreferences(options: { showSideToolbar?: boolean; autoCopy?: boolean; autoRefresh?: boolean }):
    Promise<{ showSideToolbar?: boolean; autoCopy?: boolean; autoRefresh?: boolean }>;
  refresh(): Promise<void>;
  setSize(size: number): Promise<number>;
  openSidebarAction(category: string, item?: string): Promise<{ category: string; item: string | null; dispatched: true }>;
}
export const TOOLBAR_ITEMS: Readonly<Record<string, string>>;
export const BACKEND_ACTIONS: Readonly<Record<string, Readonly<{ method: 'GET' | 'POST'; path: string }>>>;
export const MANAGEMENT_ACTIONS: Readonly<Record<string, Readonly<{ method: 'GET' | 'POST' | 'DELETE'; path: string }>>>;
export const protocol: {
  ACTION: Readonly<{ DOWN: 0; UP: 1; MOVE: 2 }>;
  CONTROL: Readonly<Record<string, number>>; FILE_STATE: Readonly<Record<string, number>>;
  KEY_CODES: Readonly<Record<string, number>>; META: Readonly<Record<string, number>>;
  INITIAL_MAGIC: Uint8Array; MESSAGE_MAGIC: Uint8Array;
  encodeKey(options: KeyOptions & { action: number; keycode: number }): Uint8Array;
  encodeText(text: string): Uint8Array;
  encodeTouch(options: TouchOptions & { action: number; x: number; y: number }): Uint8Array;
  encodeScroll(options: TouchOptions & { x: number; y: number; hScroll?: number; vScroll?: number }): Uint8Array;
  encodeSetClipboard(text: string, options?: { paste?: boolean }): Uint8Array;
  encodeScreenPower(on: boolean): Uint8Array;
  encodeCommand(type: number): Uint8Array;
  encodeVideoSettings(settings?: VideoSettings): Uint8Array;
  encodePushFile(options: { id?: number; state: number; fileName?: string; fileSize?: number; chunk?: Uint8Array }): Uint8Array;
  decodeVideoSettings(data: Uint8Array): VideoSettings;
  decodeInitial(data: Uint8Array): InitialInfo;
  decodeDeviceMessage(data: Uint8Array): null | { type: string; text?: string; id?: number; code?: number; data?: Uint8Array };
  integer(name: string, value: unknown, min: number, max: number): number;
};
