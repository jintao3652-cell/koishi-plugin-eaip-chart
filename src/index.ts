// index.ts - 简化版，仅保留 EAIP 功能
import { Context, Session, h, Schema } from 'koishi'
import axios from 'axios'
import { createCanvas, DOMMatrix } from 'canvas'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import XLSX from 'xlsx'
import { ChartFoxClient, ChartOverviewData, ChartData as ChartFoxChartData } from './CHARTFOX'

if (!(globalThis as any).DOMMatrix) {
  ;(globalThis as any).DOMMatrix = DOMMatrix
}

const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
const { getDocument, GlobalWorkerOptions } = pdfjs
GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js')

// -----------------------------
// 类型定义
// -----------------------------
interface ChartData {
  pdfPath: string
  name_cn: string
}

// -----------------------------
// 配置 Schema
// -----------------------------
export const name = 'eaip-charts'

export interface PluginConfig {
  chartfoxClientId?: string
  chartfoxClientSecret?: string
  chartfoxScope?: string
  chartfoxBaseUrl?: string
  chartfoxTokenUrl?: string
}

export const Config: Schema<PluginConfig> = Schema.object({
  chartfoxClientId: Schema.string().description('ChartFox Client ID').required(false),
  chartfoxClientSecret: Schema.string().description('ChartFox Client Secret').required(false),
  chartfoxScope: Schema.string().description('ChartFox OAuth scope').required(false),
  chartfoxBaseUrl: Schema.string().description('ChartFox API base URL').required(false),
  chartfoxTokenUrl: Schema.string().description('ChartFox OAuth token URL').required(false),
})

// -----------------------------
// 工具函数
// -----------------------------
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9-_\.]/g, '_')
}

function logInfo(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function logError(message: string, error?: any): void {
  console.error(`[${new Date().toISOString()}] ${message}`, error || '')
}

// 解析选择参数（支持 1/2/3, 1-2-3, 1 2 3 格式）
function parseSelections(input: string): number[] {
  if (!input) return []
  
  // 替换分隔符为逗号
  const normalized = input.replace(/[/-]/g, ',').replace(/\s+/g, ',')
  const parts = normalized.split(',').filter(Boolean)
  
  const selections: number[] = []
  for (const part of parts) {
    const num = parseInt(part.trim())
    if (!isNaN(num) && num > 0) {
      selections.push(num)
    }
  }
  
  return Array.from(new Set(selections)).sort((a, b) => a - b)
}

// 检查是否包含"全要"关键词
function isSelectAll(input: string): boolean {
  const keywords = ['全要', '全部', '所有', 'all', 'ALL', '*']
  return keywords.includes(input.trim())
}

// -----------------------------
// 图片选项生成
// -----------------------------
const generateOptionsImages = async (charts: ChartData[]): Promise<Buffer[]> => {
  const perColumn = 18
  const total = charts.length
  const columnCount = Math.ceil(total / perColumn) || 1
  const fontSize = 24
  const lineHeight = fontSize * 1.5
  const padding = 20
  const columnGap = 30
  
  const tempCanvas = createCanvas(1, 1)
  const ctx = tempCanvas.getContext('2d')
  ctx.font = `${fontSize}px "Microsoft YaHei"`
  
  const textMetrics = charts.map((c, i) => {
    const text = `${i + 1}. ${c.name_cn}`
    return { text, width: ctx.measureText(text).width }
  })
  
  const columnWidths: number[] = []
  for (let col = 0; col < columnCount; col++) {
    let maxWidth = 0
    const start = col * perColumn
    const end = Math.min(start + perColumn, total)
    for (let i = start; i < end; i++) {
      const spaceWidth = ctx.measureText(' ').width
      maxWidth = Math.max(maxWidth, textMetrics[i].width + spaceWidth)
    }
    columnWidths.push(maxWidth)
  }
  
  const columnRows = perColumn + 2
  const canvasHeight = padding * 2 + columnRows * lineHeight
  const canvasWidth = padding * 2 + columnWidths.reduce((a, b) => a + b, 0) + columnGap * (columnCount - 1)
  
  const images: Buffer[] = []
  for (let startIndex = 0; startIndex < charts.length; startIndex += perColumn * columnCount) {
    const chunk = charts.slice(startIndex, startIndex + perColumn * columnCount)
    const canvas = createCanvas(canvasWidth || 600, canvasHeight)
    const drawCtx = canvas.getContext('2d')
    
    drawCtx.fillStyle = '#ffffff'
    drawCtx.fillRect(0, 0, canvas.width, canvas.height)
    drawCtx.fillStyle = '#333333'
    drawCtx.font = `${fontSize}px "Microsoft YaHei"`
    
    let xOffset = padding
    for (let col = 0; col < columnCount; col++) {
      const columnWidth = columnWidths[col] || 100
      const colStart = col * perColumn
      const colEnd = Math.min(colStart + perColumn, chunk.length)
      
      let yOffset = padding + lineHeight
      for (let i = colStart; i < colEnd; i++) {
        const globalIndex = startIndex + i
        const text = textMetrics[globalIndex]?.text || `${globalIndex + 1}.`
        drawCtx.fillText(text, xOffset, yOffset)
        yOffset += lineHeight
      }
      yOffset += lineHeight
      xOffset += columnWidth + columnGap
    }
    
    images.push(canvas.toBuffer('image/png'))
  }
  
  return images
}

// -----------------------------
// PDF 相关辅助函数
// -----------------------------
const getPdfDocument = async (pdfBuffer: Buffer) => {
  logInfo('[getPdfDocument] 正在加载 PDF 文档...')
  const loadingTask = getDocument({ 
    data: new Uint8Array(pdfBuffer), 
    useSystemFonts: true, 
    verbosity: 0 
  })
  const pdfDoc = await loadingTask.promise
  logInfo(`[getPdfDocument] PDF 文档加载成功，共 ${pdfDoc.numPages} 页`)
  return pdfDoc
}

const renderPdfPage = async (pdf: any, pageNumber: number): Promise<Buffer> => {
  logInfo(`[renderPdfPage] 正在渲染第 ${pageNumber} 页...`)
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1.5 })
  const canvas = createCanvas(viewport.width, viewport.height)
  const ctx = canvas.getContext('2d')
  
  await page.render({ 
    canvasContext: ctx as any, 
    viewport, 
    background: 'rgba(255,255,255,1)' 
  }).promise
  
  logInfo(`[renderPdfPage] 第 ${pageNumber} 页渲染完成`)
  return canvas.toBuffer('image/jpeg', { quality: 0.8 })
}

// -----------------------------
// 读取本地 airports.xlsx
// -----------------------------
const loadLocalAirports = (cwdPath?: string) => {
  try {
    const path = resolve(cwdPath || __dirname, 'airports.xlsx')
    if (!existsSync(path)) {
      logInfo('[AIRPORT_DATA] airports.xlsx 未找到，跳过本地机场列表加载')
      return [] as Array<{ icao: string; name: string; iata: string }>
    }
    
    logInfo('[AIRPORT_DATA] 正在读取 Excel 机场数据...')
    const workbook = XLSX.readFile(path)
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const jsonData = XLSX.utils.sheet_to_json<{ CODE_ID: string; TXT_NAME: string; CODE_IATA: string }>(
      sheet, 
      { header: ['CODE_ID', 'TXT_NAME', 'CODE_IATA'], range: 1 }
    )
    
    const data = jsonData
      .filter(a => a.CODE_ID && a.CODE_IATA)
      .map(a => ({ 
        icao: a.CODE_ID.toUpperCase(), 
        name: a.TXT_NAME, 
        iata: a.CODE_IATA.toUpperCase() 
      }))
    
    logInfo(`[AIRPORT_DATA] 成功加载 ${data.length} 个机场数据`)
    return data
  } catch (error) {
    logError('[AIRPORT_DATA] 读取机场数据失败:', error)
    return []
  }
}

// -----------------------------
// 单个航图处理函数
// -----------------------------
const processSingleChart = async (
  session: Session, 
  chart: ChartData, 
  page: number = 1,
  tempDir: string
): Promise<void> => {
  try {
    const pdfUrl = `http://naip.cnrpg.top:10086/${chart.pdfPath}`
    logInfo(`[processSingleChart] 开始下载 PDF: ${pdfUrl}`)
    
    const { data: pdfBuffer } = await axios.get(pdfUrl, { 
      responseType: 'arraybuffer', 
      timeout: 20000 
    })
    
    logInfo(`[processSingleChart] PDF 下载成功，大小: ${pdfBuffer.byteLength} 字节`)
    const fileName = `${sanitizeFilename(chart.name_cn)}.pdf`
    const filePath = join(tempDir, fileName)
    writeFileSync(filePath, pdfBuffer)
    
    const pdf = await getPdfDocument(pdfBuffer)
    const totalPages = pdf.numPages
    
    if (page < 1 || page > totalPages) {
      pdf.destroy()
      await session.send(`页码无效，有效范围 1-${totalPages}`)
      return
    }
    
    const messageParts: any[] = [
      `📄 ${chart.name_cn}\n`,
      `📖 页码：${page}/${totalPages}`,
    ]
    
    // 总页数大于等于2时发送文件，否则发送预览图
    if (totalPages >= 2) {
      messageParts.push(h.file(pathToFileURL(filePath).href))
    } else {
      try {
        const previewImage = await renderPdfPage(pdf, page)
        messageParts.push(h.image(previewImage, 'image/jpeg'))
      } catch (renderError) {
        logError('[processSingleChart] 预览图生成失败:', renderError)
        messageParts.push(h.file(pathToFileURL(filePath).href))
      }
    }
    
    await session.send(messageParts)
    pdf.destroy()
    
    // 5分钟后清理文件
    setTimeout(() => {
      try {
        unlinkSync(filePath)
        logInfo(`[processSingleChart] 已清理临时文件: ${filePath}`)
      } catch (cleanupError) {
        logError('[processSingleChart] 临时文件清理失败:', cleanupError)
      }
    }, 300_000)
    
  } catch (error: any) {
    logError(`[processSingleChart] 处理航图失败 ${chart.name_cn}:`, error)
    await session.send(`处理航图 "${chart.name_cn}" 失败: ${error.message}`)
  }
}

// -----------------------------
// 主应用函数
// -----------------------------
export function apply(ctx: Context, config: PluginConfig) {
  logInfo('[apply] 初始化 eaip-chart 模块...')
  
  // 本地机场数据
  const AIRPORT_DATA = loadLocalAirports(process.cwd())
  
  // 临时目录
  const TEMP_DIR = resolve(process.cwd(), 'temp')
  mkdirSync(TEMP_DIR, { recursive: true })
  logInfo('[apply] 临时目录路径：' + TEMP_DIR)
  
  // ---------- 主命令 ----------
  ctx.command('eaip <input:text>', '查询机场航图（支持ICAO/IATA/中文名称/模糊匹配）')
    .alias('航图', 'naip')
    .option('page', '-p <页码:number>', { fallback: 1 })
    .action(async ({ session, options }, input) => {
      if (!session || !input) return '请输入查询内容'
      
      logInfo(`[command eaip] 接收到输入: ${input}`)
      
      // 解析输入：机场代码和选择参数
      const args = input.trim().split(/\s+/)
      const airportCodeOrName = args[0].toUpperCase()
      const selectionsInput = args.slice(1).join(' ')
      
      // 解析选择参数
      const selections = parseSelections(selectionsInput)
      const isAllSelected = isSelectAll(selectionsInput)
      
      // 查找机场
      let icao: string = ''
      
      // 1. 检查是否为 ICAO 代码 (4位字母)
      if (/^[A-Z]{4}$/.test(airportCodeOrName)) {
        icao = airportCodeOrName
        const airport = AIRPORT_DATA.find(a => a.icao === icao)
        if (!airport) {
          await session.send(`未找到 ICAO 代码 ${icao} 对应的机场`)
          return
        }
        await session.send(`找到机场: ${airport.name} (${icao})`)
      }
      // 2. 检查是否为 IATA 代码 (3位字母)
      else if (/^[A-Z]{3}$/.test(airportCodeOrName)) {
        const airports = AIRPORT_DATA.filter(a => a.iata === airportCodeOrName)
        if (airports.length === 0) {
          await session.send(`未找到 IATA 代码 ${airportCodeOrName} 对应的机场`)
          return
        }
        
        if (airports.length === 1) {
          icao = airports[0].icao
          await session.send(`找到机场: ${airports[0].name} (${icao})`)
        } else {
          const message = ['找到多个匹配的机场:']
          airports.forEach((airport, index) => {
            message.push(`${index + 1}. ${airport.name} (${airport.icao}/${airport.iata})`)
          })
          message.push('请回复编号选择:')
          
          await session.send(message.join('\n'))
          const choice = await session.prompt(60000)
          if (!choice) return '选择超时'
          
          const index = parseInt(choice) - 1
          if (isNaN(index) || index < 0 || index >= airports.length) {
            return '选择无效'
          }
          
          icao = airports[index].icao
          await session.send(`已选择: ${airports[index].name} (${icao})`)
        }
      }
      // 3. 中文或模糊名称搜索
      else {
        const keyword = airportCodeOrName.toLowerCase()
        const airports = AIRPORT_DATA.filter(a => 
          a.name.toLowerCase().includes(keyword) || 
          a.icao.toLowerCase().includes(keyword) ||
          a.iata.toLowerCase().includes(keyword)
        )
        
        if (airports.length === 0) {
          await session.send(`未找到包含 "${airportCodeOrName}" 的机场`)
          return
        }
        
        if (airports.length === 1) {
          icao = airports[0].icao
          await session.send(`找到机场: ${airports[0].name} (${icao})`)
        } else {
          const message = ['找到多个匹配的机场:']
          airports.forEach((airport, index) => {
            message.push(`${index + 1}. ${airport.name} (${airport.icao}/${airport.iata})`)
          })
          message.push('请回复编号选择:')
          
          await session.send(message.join('\n'))
          const choice = await session.prompt(60000)
          if (!choice) return '选择超时'
          
          const index = parseInt(choice) - 1
          if (isNaN(index) || index < 0 || index >= airports.length) {
            return '选择无效'
          }
          
          icao = airports[index].icao
          await session.send(`已选择: ${airports[index].name} (${icao})`)
        }
      }
      
      // 获取航图数据
      try {
        logInfo(`[EAIP] 查询机场 ${icao} 的航图数据...`)
        const { data } = await axios.get<ChartData[]>('http://naip.cnrpg.top:10086/Data/JsonPath/AD.JSON', { 
          timeout: 15000 
        })
        
        // 筛选该机场的航图
        const charts = data.filter(item => 
          item.pdfPath.toUpperCase().includes(`/TERMINAL/${icao}`) && 
          item.name_cn.toUpperCase().startsWith(icao)
        )
        
        if (charts.length === 0) {
          return `未找到 ${icao} 的航图信息`
        }
        
        logInfo(`[EAIP] 找到 ${charts.length} 个航图`)
        
        // 如果有名称模糊匹配参数
        if (args.length > 1 && !selections.length && !isAllSelected) {
          const nameKeyword = args.slice(1).join(' ').toLowerCase()
          const filteredCharts = charts.filter(chart => 
            chart.name_cn.toLowerCase().includes(nameKeyword)
          )
          
          if (filteredCharts.length === 0) {
            await session.send(`未找到名称包含 "${nameKeyword}" 的航图`)
            
            // 显示所有航图让用户选择
            const optionImages = await generateOptionsImages(charts)
            const choiceMessage = [
              `找到 ${charts.length} 个航图:`,
              ...optionImages.map(image => h.image(image, 'image/png')),
              '请回复编号选择（支持格式：1/2/3, 1-2-3, 1 2 3，或输入"全要"获取所有航图）:'
            ]
            await session.send(choiceMessage)
            
            const choice = await session.prompt(60000)
            if (!choice) return '选择超时'
            
            if (isSelectAll(choice)) {
              // 处理所有航图
              await session.send(`开始处理 ${charts.length} 个航图...`)
              for (let i = 0; i < charts.length; i++) {
                await processSingleChart(session, charts[i], options.page, TEMP_DIR)
              }
              return
            }
            
            const userSelections = parseSelections(choice)
            if (userSelections.length === 0) return '选择无效'
            
            // 处理用户选择的航图
            for (const selection of userSelections) {
              if (selection >= 1 && selection <= charts.length) {
                await processSingleChart(session, charts[selection - 1], options.page, TEMP_DIR)
              }
            }
            return
          }
          
          // 只有一个匹配结果，直接输出
          if (filteredCharts.length === 1) {
            await session.send(`找到 1 个匹配的航图: ${filteredCharts[0].name_cn}`)
            await processSingleChart(session, filteredCharts[0], options.page, TEMP_DIR)
            return
          }
          
          // 多个匹配结果，显示让用户选择
          const optionImages = await generateOptionsImages(filteredCharts)
          const choiceMessage = [
            `找到 ${filteredCharts.length} 个名称包含 "${nameKeyword}" 的航图:`,
            ...optionImages.map(image => h.image(image, 'image/png')),
            '请回复编号选择（支持格式：1/2/3, 1-2-3, 1 2 3，或输入"全要"获取所有匹配航图）:'
          ]
          await session.send(choiceMessage)
          
          const choice = await session.prompt(60000)
          if (!choice) return '选择超时'
          
          if (isSelectAll(choice)) {
            await session.send(`开始处理 ${filteredCharts.length} 个航图...`)
            for (const chart of filteredCharts) {
              await processSingleChart(session, chart, options.page, TEMP_DIR)
            }
            return
          }
          
          const userSelections = parseSelections(choice)
          if (userSelections.length === 0) return '选择无效'
          
          for (const selection of userSelections) {
            if (selection >= 1 && selection <= filteredCharts.length) {
              await processSingleChart(session, filteredCharts[selection - 1], options.page, TEMP_DIR)
            }
          }
          return
        }
        
        // 如果有选择参数
        if (selections.length > 0) {
          for (const selection of selections) {
            if (selection >= 1 && selection <= charts.length) {
              await processSingleChart(session, charts[selection - 1], options.page, TEMP_DIR)
            } else {
              await session.send(`编号 ${selection} 无效，有效范围 1-${charts.length}`)
            }
          }
          return
        }
        
        // 如果选择"全要"
        if (isAllSelected) {
          await session.send(`开始处理所有 ${charts.length} 个航图...`)
          for (const chart of charts) {
            await processSingleChart(session, chart, options.page, TEMP_DIR)
          }
          return
        }
        
        // 默认情况：显示所有航图让用户选择
        const optionImages = await generateOptionsImages(charts)
        const choiceMessage = [
          `找到 ${charts.length} 个航图:`,
          ...optionImages.map(image => h.image(image, 'image/png')),
          '请回复编号选择（支持格式：1/2/3, 1-2-3, 1 2 3，或输入"全要"获取所有航图）:'
        ]
        await session.send(choiceMessage)
        
        const choice = await session.prompt(60000)
        if (!choice) return '选择超时'
        
        if (isSelectAll(choice)) {
          await session.send(`开始处理所有 ${charts.length} 个航图...`)
          for (const chart of charts) {
            await processSingleChart(session, chart, options.page, TEMP_DIR)
          }
          return
        }
        
        const userSelections = parseSelections(choice)
        if (userSelections.length === 0) return '选择无效'
        
        for (const selection of userSelections) {
          if (selection >= 1 && selection <= charts.length) {
            await processSingleChart(session, charts[selection - 1], options.page, TEMP_DIR)
          }
        }
        
      } catch (error: any) {
        logError('[command eaip] 查询失败:', error)
        return `查询失败: ${error.message}`
      }
    })

  ctx.command('chartfox <input:text>', 'Query ChartFox charts by ICAO')
    .alias('cf')
    .action(async ({ session }, input) => {
      if (!session || !input) return 'Please input an ICAO code.'
      if (!config.chartfoxClientId || !config.chartfoxClientSecret) {
        return 'ChartFox credentials are not configured.'
      }

      const args = input.trim().split(/\s+/)
      const airportIdent = args[0].toUpperCase()
      if (!/^[A-Z]{4}$/.test(airportIdent)) {
        return 'Please provide a 4-letter ICAO code.'
      }

      const selectionsInput = args.slice(1).join(' ')
      const selections = parseSelections(selectionsInput)
      const isAllSelected = isSelectAll(selectionsInput)

      const client = new ChartFoxClient({
        clientId: config.chartfoxClientId,
        clientSecret: config.chartfoxClientSecret,
        scope: config.chartfoxScope,
        baseUrl: config.chartfoxBaseUrl,
        tokenUrl: config.chartfoxTokenUrl,
        timeoutMs: 15000,
      })

      const formatCharts = (charts: ChartOverviewData[]) =>
        charts
          .map((chart, index) => {
            const typeLabel = chart.type_key || 'Unknown'
            return `${index + 1}. ${chart.name} (${typeLabel}) [${chart.id}]`
          })
          .join('\n')

      const sendChartDetail = async (chartId: string, fallbackName?: string) => {
        const chart: ChartFoxChartData = await client.getChart(chartId)
        const directUrl = chart.url || chart.files?.[0]?.url
        const lines: string[] = [
          `Chart: ${chart.name || fallbackName || chartId}`,
          `ID: ${chart.id}`,
        ]
        if (chart.view_url) lines.push(`View: ${chart.view_url}`)
        if (directUrl) lines.push(`URL: ${directUrl}`)
        if (chart.requires_preauth) lines.push('Note: requires preauth/acknowledgement')
        await session.send(lines.join('\n'))
      }

      try {
        const charts = await client.listAirportCharts(airportIdent)
        if (charts.length === 0) {
          return `No ChartFox charts found for ${airportIdent}.`
        }

        if (isAllSelected) {
          for (const chart of charts) {
            await sendChartDetail(chart.id, chart.name)
          }
          return
        }

        if (selections.length > 0) {
          for (const selection of selections) {
            if (selection >= 1 && selection <= charts.length) {
              await sendChartDetail(charts[selection - 1].id, charts[selection - 1].name)
            } else {
              await session.send(`Invalid selection: ${selection}.`)
            }
          }
          return
        }

        await session.send(
          `Found ${charts.length} ChartFox charts for ${airportIdent}:\n` +
            `${formatCharts(charts)}\n` +
            'Reply with numbers (e.g. 1/2/3) or "all".',
        )
        const choice = await session.prompt(60000)
        if (!choice) return 'Selection timeout.'

        if (isSelectAll(choice)) {
          for (const chart of charts) {
            await sendChartDetail(chart.id, chart.name)
          }
          return
        }

        const userSelections = parseSelections(choice)
        if (userSelections.length === 0) return 'Invalid selection.'

        for (const selection of userSelections) {
          if (selection >= 1 && selection <= charts.length) {
            await sendChartDetail(charts[selection - 1].id, charts[selection - 1].name)
          }
        }
      } catch (error: any) {
        logError('[command chartfox] Query failed:', error)
        return `Query failed: ${error.message}`
      }
    })
}
