// 纯函数单元测试：node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeArg, safeFile, clampInt, assertShellSafe } from '../lib/validate.mjs';
import { parseJson, parseTrail, parseNodeKind, extractSource, isImportRef, fuzzyMatch, looksLikeNodeOutput } from '../lib/textparse.mjs';
import { parseRouteFile, matchRoute, parseGoRouteFile, parseBeegoAnnotations } from '../lib/routes.mjs';
import { matchUrlPattern, parseSegTokens, matchSeg } from '../lib/urlmap.mjs';
import { parseSourceCalls, lastSeg } from '../lib/sourcecalls.mjs';

// ===== validate =====
test('safeArg 拒绝控制字符（含换行/制表）', () => {
  assert.equal(safeArg('getList'), 'getList');
  assert.equal(safeArg('a\nb'), null);
  assert.equal(safeArg('a\rb'), null);
  assert.equal(safeArg('a\tb'), null);
  assert.equal(safeArg('a\x00b'), null);
  assert.equal(safeArg('  x  '), 'x');
  assert.equal(safeArg(''), null);
  assert.equal(safeArg('x'.repeat(201)), null);
  assert.equal(safeArg(null), null);
});

test('safeFile 拒绝盘符/绝对路径/穿越', () => {
  assert.equal(safeFile('src/a.ts'), 'src/a.ts');
  assert.equal(safeFile('C:/foo/bar.ts'), null);
  assert.equal(safeFile('/etc/passwd'), null);
  assert.equal(safeFile('../secret'), null);
  assert.equal(safeFile('a/../../b'), null);
  assert.equal(safeFile('a\\b.php'), 'a/b.php');
});

test('assertShellSafe 拦截 cmd 元字符', () => {
  assert.doesNotThrow(() => assertShellSafe(['query', 'getList', '--json']));
  assert.throws(() => assertShellSafe(['a&calc']));
  assert.throws(() => assertShellSafe(['a|b']));
  assert.throws(() => assertShellSafe(['%PATH%']));
  assert.throws(() => assertShellSafe(['a^b']));
  assert.throws(() => assertShellSafe(['a"b']));
});

test('clampInt 上下限与非法输入', () => {
  assert.equal(clampInt('6', 6, 1, 10), 6);
  assert.equal(clampInt('99', 6, 1, 10), 10);
  assert.equal(clampInt('-5', 6, 1, 10), 1);
  assert.equal(clampInt('abc', 6, 1, 10), 6);
  assert.equal(clampInt(undefined, 300, 10, 800), 300);
});

// ===== textparse（codegraph CLI 输出契约） =====
const NODE_OUT = `**getList** (method) — src/a.ts:12

\`\`\`typescript
async getList() { return this.repo.find(); }
\`\`\`

### Trail
**Calls →** find (src/repo.ts:5), query (src/db.ts:9), +3 more
**Called by ←** listHandler (src/ctrl.ts:20)
`;

test('parseNodeKind 解析首行 kind', () => {
  assert.equal(parseNodeKind(NODE_OUT), 'method');
  assert.equal(parseNodeKind('garbage'), null);
});

test('parseTrail 解析 Calls / Called by', () => {
  const calls = parseTrail(NODE_OUT, 'Calls →');
  assert.deepEqual(calls.map(c => c.name), ['find', 'query']);
  assert.equal(calls[0].filePath, 'src/repo.ts');
  assert.equal(calls[0].startLine, 5);
  const by = parseTrail(NODE_OUT, 'Called by ←');
  assert.equal(by.length, 1);
  assert.equal(by[0].name, 'listHandler');
  assert.deepEqual(parseTrail('no trail here', 'Calls →'), []);
});

test('extractSource 提取代码块', () => {
  assert.match(extractSource(NODE_OUT), /async getList/);
  assert.equal(extractSource('no code'), '');
});

test('isImportRef / fuzzyMatch / parseJson', () => {
  assert.ok(isImportRef('@/lib/x'));
  assert.ok(isImportRef('./a'));
  assert.ok(!isImportRef('getList'));
  assert.ok(fuzzyMatch('getlst', 'getList'));
  assert.ok(fuzzyMatch('gl', 'getList'));
  assert.ok(!fuzzyMatch('xyz', 'getList'));
  assert.deepEqual(parseJson('not json', []), []);
  assert.deepEqual(parseJson('{"a":1}', null), { a: 1 });
});

test('looksLikeNodeOutput 识别正常输出与格式漂移', () => {
  assert.ok(looksLikeNodeOutput(NODE_OUT));
  assert.ok(looksLikeNodeOutput('ℹ No results'));
  assert.ok(!looksLikeNodeOutput('TOTAL GARBAGE OUTPUT'));
});

// ===== routes =====
test('parseRouteFile 基础 + 嵌套 prefix（大括号计数）', () => {
  const src = `<?php
Route::prefix('api')->group(function () {
    Route::get('user/list', 'UserController@list');
    Route::prefix('admin')->group(function () {
        Route::post('ban', 'BanController@add');
    });
    Route::get('room', 'RoomController@index');
});
Route::get('health', 'HealthController@check');
`;
  const r = parseRouteFile(src, 'routes/api.php');
  assert.deepEqual(r.map(x => [x.method, x.url, x.handler]), [
    ['GET', 'api/user/list', 'UserController@list'],
    ['POST', 'api/admin/ban', 'BanController@add'],
    ['GET', 'api/room', 'RoomController@index'],
    ['GET', 'health', 'HealthController@check'],
  ]);
});

test('parseRouteFile 链式 middleware()->prefix()->group()', () => {
  const src = `Route::middleware(['auth'])->prefix('v2')->group(function () {
    Route::get('goods', 'GoodsController@index');
});`;
  const r = parseRouteFile(src, 'routes/web.php');
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'v2/goods');
});

test('parseRouteFile resource / apiResource 展开', () => {
  const src = `Route::resource('photos', 'PhotoController');
Route::apiResource('videos', 'VideoController');`;
  const r = parseRouteFile(src, 'routes/api.php');
  assert.equal(r.length, 12);
  assert.ok(r.some(x => x.method === 'GET' && x.url === 'photos' && x.handler === 'PhotoController@index'));
  assert.ok(r.some(x => x.method === 'DELETE' && x.url === 'photos/{id}' && x.handler === 'PhotoController@destroy'));
  assert.ok(r.some(x => x.method === 'PUT' && x.url === 'videos/{id}' && x.handler === 'VideoController@update'));
});

test('parseRouteFile 文件引用 group 不累积前缀', () => {
  const src = `Route::prefix('api')->group(__DIR__.'/v1.php');
Route::get('x', 'XController@index');`;
  const r = parseRouteFile(src, 'routes/web.php');
  assert.equal(r[0].url, 'x');
});

test('matchRoute 通配与正则转义', () => {
  assert.ok(matchRoute('group/multiGroup.json', 'group/multiGroup.json'));
  assert.ok(matchRoute('user/{id}', 'user/123'));
  assert.ok(!matchRoute('user/{id}', 'user/123/edit'));
  // . 必须按字面匹配，不吞任意字符
  assert.ok(!matchRoute('goods.json', 'goodsXjson'));
  assert.ok(matchRoute('goods.json', 'goods.json'));
  // Go 风格：:id 单段通配，*filepath 多段通配
  assert.ok(matchRoute('user/:id', 'user/123'));
  assert.ok(!matchRoute('user/:id', 'user/123/edit'));
  assert.ok(matchRoute('static/*filepath', 'static/a/b/c.js'));
  assert.ok(matchRoute('static/*filepath', 'static'));
});

// ===== Go 路由：beego / gin =====
test('parseGoRouteFile beego NewNamespace 嵌套 + NSRouter 方法映射', () => {
  const src = `package routers

import (
	"github.com/astaxie/beego"
	"ban-server/controllers"
)

func init() {
	ns := beego.NewNamespace("/v1",
		beego.NSNamespace("/ban",
			beego.NSInclude(
				&controllers.BanController{},
			),
			beego.NSRouter("/add", &controllers.BanController{},"post:Add"),
			beego.NSRouter("/getOne", &controllers.BanController{},"get:GetOne"),
		),
		beego.NSNamespace("/reason",
			beego.NSRouter("/list", &controllers.ReasonController{},"get:List"),
		),
	)
	beego.AddNamespace(ns)
	beego.Router("/health", &controllers.SysController{}, "get:Check")
}
`;
  const r = parseGoRouteFile(src, 'routers/router.go');
  const got = r.map(x => [x.method, x.url, x.handler]);
  assert.deepEqual(got, [
    ['POST', 'v1/ban/add', 'BanController@Add'],
    ['GET', 'v1/ban/getOne', 'BanController@GetOne'],
    ['GET', 'v1/reason/list', 'ReasonController@List'],
    ['GET', 'health', 'SysController@Check'],
  ]);
});

test('parseGoRouteFile beego 方法映射多方法 + 裸方法名', () => {
  const src = `beego.Router("/x", &c.FooController{}, "get:List;post:Create")
beego.Router("/y", &c.FooController{}, "delete")`;
  const r = parseGoRouteFile(src, 'routers/r.go');
  assert.deepEqual(r.map(x => [x.method, x.url, x.handler]), [
    ['GET', 'x', 'FooController@List'],
    ['POST', 'x', 'FooController@Create'],
    ['DELETE', 'y', 'FooController@Delete'],
  ]);
});

test('parseGoRouteFile beego NSInclude + @router 注解', () => {
  const ctrlSrc = `package controllers

type BanController struct { beego.Controller }

// @router /online [get]
func (c *BanController) Online() {}

// @router /offline/:id [post,delete]
func (c *BanController) Offline() {}
`;
  const ann = parseBeegoAnnotations(ctrlSrc);
  assert.equal(ann.length, 2);
  assert.deepEqual(ann[0].methods, ['GET']);
  assert.equal(ann[1].fn, 'Offline');
  assert.deepEqual(ann[1].methods, ['POST', 'DELETE']);

  const controllerFiles = new Map([['BanController', { file: 'controllers/ban.go', routes: ann }]]);
  const routerSrc = `beego.NewNamespace("/v1",
	beego.NSNamespace("/ban",
		beego.NSInclude(&controllers.BanController{}),
	),
)`;
  const r = parseGoRouteFile(routerSrc, 'routers/router.go', controllerFiles);
  const got = r.map(x => [x.method, x.url, x.handler]);
  assert.deepEqual(got, [
    ['GET', 'v1/ban/online', 'BanController@Online'],
    ['POST', 'v1/ban/offline/:id', 'BanController@Offline'],
    ['DELETE', 'v1/ban/offline/:id', 'BanController@Offline'],
  ]);
});

test('parseGoRouteFile beego 内联处理器直接带文件行号', () => {
  const src = `beego.Get("/ping", func(ctx *context.Context) { ctx.WriteString("pong") })`;
  const r = parseGoRouteFile(src, 'main.go');
  assert.equal(r.length, 1);
  assert.equal(r[0].method, 'GET');
  assert.equal(r[0].url, 'ping');
  assert.equal(r[0].filePath, 'main.go');
  assert.equal(r[0].startLine, 1);
});

test('parseGoRouteFile gin Group 前缀 + 变量类型追踪 + 中间件链', () => {
  const src = `package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	banCtl := &controllers.BanController{}
	v1 := r.Group("/api/v1")
	{
		v1.GET("/ban/list", banCtl.List)
		v1.POST("/ban/add", mw.Auth(), banCtl.Add)
		v1.GET("/ping", func(c *gin.Context) { c.JSON(200, nil) })
		v1.GET("/config", controllers.GetConfig)
	}
}`;
  const r = parseGoRouteFile(src, 'main.go');
  const got = r.map(x => [x.method, x.url, x.handler]);
  assert.deepEqual(got, [
    ['GET', 'api/v1/ban/list', 'BanController@List'],
    ['POST', 'api/v1/ban/add', 'BanController@Add'],
    ['GET', 'api/v1/ping', '(匿名处理器)'],
    ['GET', 'api/v1/config', 'GetConfig'],
  ]);
});

test('parseGoRouteFile gin 未知接收者仅认常见变量名', () => {
  const src = `whatever.GET("/a", x.Y)
r.POST("/b", x.Z)`;
  const r = parseGoRouteFile(src, 'main.go');
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'b');
});

// ===== urlmap =====
test('parseSegTokens / matchSeg 混合段', () => {
  assert.deepEqual(parseSegTokens('{controller}-{method}.html'), [
    { t: 'var', v: 'controller' }, { t: 'lit', v: '-' }, { t: 'var', v: 'method' }, { t: 'lit', v: '.html' },
  ]);
  const out = {};
  assert.ok(matchSeg('{controller}-{method}.html', 'tv-room.html', out));
  assert.deepEqual(out, { controller: 'tv', method: 'room' });
});

test('matchUrlPattern 段数与变量提取', () => {
  assert.deepEqual(matchUrlPattern('/{module}/{controller}-{method}.html', '/tv/room-index.html'), { module: 'tv', controller: 'room', method: 'index' });
  assert.equal(matchUrlPattern('/{a}/{b}', '/x'), null);
});

// ===== sourcecalls =====
test('lastSeg 提取类名末段', () => {
  assert.equal(lastSeg('Services\\Apis\\Group\\InfoService'), 'InfoService');
  assert.equal(lastSeg('InfoService'), 'InfoService');
});

test('parseSourceCalls TS：new/工厂/this 字段/同类方法', () => {
  const src = `
class VideoService {
  async audit() {
    const repo = new VideoRepository();
    await repo.findById(1);
    await this.helper.format();
    await this.notify();
  }
}`;
  const calls = parseSourceCalls(src, null, null);
  assert.ok(calls.some(c => c.cls === 'VideoRepository' && c.method === 'findById'));
  // 无文件时 className 为 null，this.xxx() 同类调用不解析
  assert.ok(!calls.some(c => c.method === 'notify'));
});

test('parseSourceCalls PHP：instance 链式与 $this', () => {
  const src = `<?php
class ShopController {
  public function goodsBatch() {
    $svc = InfoService::instance();
    $svc->getList();
    CacheService::instance()->get('k');
    $this->render();
  }
}`;
  const calls = parseSourceCalls(src, null, null);
  assert.ok(calls.some(c => c.cls === 'InfoService' && c.method === 'getList'));
  assert.ok(calls.some(c => c.cls === 'CacheService' && c.method === 'get'));
});
