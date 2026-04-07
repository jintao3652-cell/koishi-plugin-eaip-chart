import axios, { AxiosInstance } from 'axios'

export interface ChartOverviewData {
  id: string
  airport_icao: string
  name: string
  code?: string | null
  type?: number
  type_key?: string
  parent_id?: string | null
  view_url?: string | null
  has_georeferences?: boolean | null
  meta?: Array<{
    type: number
    type_key: string
    value: Array<string | number>
  }>
}

export interface ChartData {
  id: string
  airport_icao?: string
  name: string
  code?: string | null
  type?: number
  type_key?: string
  url?: string | null
  view_url?: string | null
  source_url?: string | null
  files?: Array<{
    type: number
    url: string
  }>
  requires_preauth?: boolean | null
  allows_iframe?: boolean | null
  has_georeferences?: boolean | null
}

interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
}

export interface ChartFoxClientOptions {
  clientId: string
  clientSecret: string
  scope?: string
  baseUrl?: string
  tokenUrl?: string
  timeoutMs?: number
}

export class ChartFoxClient {
  private readonly http: AxiosInstance
  private readonly tokenUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly scope?: string
  private accessToken?: string
  private accessTokenExpiresAt?: number

  constructor(options: ChartFoxClientOptions) {
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.scope = options.scope
    const baseUrl = options.baseUrl || 'https://api.chartfox.org'
    this.tokenUrl = options.tokenUrl || `${baseUrl}/oauth/token`
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: options.timeoutMs || 15000,
    })
  }

  private isTokenValid(): boolean {
    if (!this.accessToken) return false
    if (!this.accessTokenExpiresAt) return true
    return Date.now() < this.accessTokenExpiresAt
  }

  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.accessToken as string
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    })
    if (this.scope) body.set('scope', this.scope)

    const { data } = await axios.post<TokenResponse>(this.tokenUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: this.http.defaults.timeout,
    })

    this.accessToken = data.access_token
    if (data.expires_in) {
      const bufferMs = 30_000
      this.accessTokenExpiresAt = Date.now() + Math.max(0, data.expires_in * 1000 - bufferMs)
    } else {
      this.accessTokenExpiresAt = undefined
    }

    return this.accessToken
  }

  private async request<T>(path: string) {
    const token = await this.getAccessToken()
    return this.http.get<T>(path, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
  }

  async listAirportCharts(airportIdent: string): Promise<ChartOverviewData[]> {
    const { data } = await this.request<{ data?: ChartOverviewData[] }>(
      `/v2/airports/${airportIdent}/charts`,
    )
    if (Array.isArray((data as any)?.data)) {
      return (data as any).data
    }
    if (Array.isArray(data as any)) {
      return data as any
    }
    return []
  }

  async getChart(chartId: string): Promise<ChartData> {
    const { data } = await this.request<ChartData>(`/v2/charts/${chartId}`)
    return data
  }
}
