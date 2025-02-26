import {
  Integration,
  DatasourceFieldType,
  QueryType,
  PaginationConfig,
  IntegrationBase,
  PaginationValues,
  RestQueryFields as RestQuery,
  RestConfig,
  RestAuthType,
  RestBasicAuthConfig,
  RestBearerAuthConfig,
  HttpMethod,
} from "@budibase/types"
import get from "lodash/get"
import * as https from "https"
import qs from "querystring"
import fetch from "node-fetch"
import { formatBytes } from "../utilities"
import { performance } from "perf_hooks"
import FormData from "form-data"
import { URLSearchParams } from "url"
import { blacklist } from "@budibase/backend-core"
import { handleFileResponse, handleXml } from "./utils"
import { parse } from "content-disposition"
import path from "path"
import { Builder as XmlBuilder } from "xml2js"

enum BodyType {
  NONE = "none",
  FORM_DATA = "form",
  XML = "xml",
  ENCODED = "encoded",
  JSON = "json",
  TEXT = "text",
}

const coreFields = {
  path: {
    type: DatasourceFieldType.STRING,
    display: "URL",
  },
  queryString: {
    type: DatasourceFieldType.STRING,
  },
  headers: {
    type: DatasourceFieldType.OBJECT,
  },
  enabledHeaders: {
    type: DatasourceFieldType.OBJECT,
  },
  requestBody: {
    type: DatasourceFieldType.JSON,
  },
  bodyType: {
    type: DatasourceFieldType.STRING,
    enum: Object.values(BodyType),
  },
  pagination: {
    type: DatasourceFieldType.OBJECT,
  },
}

const SCHEMA: Integration = {
  docs: "https://github.com/node-fetch/node-fetch",
  description:
    "With the REST API datasource, you can connect, query and pull data from multiple REST APIs. You can then use the retrieved data to build apps.",
  friendlyName: "REST API",
  type: "API",
  datasource: {
    url: {
      type: DatasourceFieldType.STRING,
      default: "",
      required: false,
      deprecated: true,
    },
    defaultHeaders: {
      type: DatasourceFieldType.OBJECT,
      required: false,
      default: {},
    },
    rejectUnauthorized: {
      display: "Reject Unauthorized",
      type: DatasourceFieldType.BOOLEAN,
      default: true,
      required: false,
    },
  },
  query: {
    create: {
      readable: true,
      displayName: HttpMethod.POST,
      type: QueryType.FIELDS,
      fields: coreFields,
    },
    read: {
      displayName: HttpMethod.GET,
      readable: true,
      type: QueryType.FIELDS,
      fields: coreFields,
    },
    update: {
      displayName: HttpMethod.PUT,
      readable: true,
      type: QueryType.FIELDS,
      fields: coreFields,
    },
    patch: {
      displayName: HttpMethod.PATCH,
      readable: true,
      type: QueryType.FIELDS,
      fields: coreFields,
    },
    delete: {
      displayName: HttpMethod.DELETE,
      type: QueryType.FIELDS,
      fields: coreFields,
    },
  },
}

class RestIntegration implements IntegrationBase {
  private config: RestConfig
  private headers: {
    [key: string]: string
  } = {}
  private startTimeMs: number = performance.now()

  constructor(config: RestConfig) {
    this.config = config
  }

  async parseResponse(response: any, pagination: PaginationConfig | null) {
    let data: any[] | string | undefined,
      raw: string | undefined,
      headers: Record<string, string> = {},
      filename: string | undefined

    const contentType = response.headers.get("content-type") || ""
    const contentDisposition = response.headers.get("content-disposition") || ""
    if (
      contentDisposition.includes("filename") ||
      contentDisposition.includes("attachment") ||
      contentDisposition.includes("form-data")
    ) {
      filename =
        path.basename(parse(contentDisposition).parameters?.filename) || ""
    }
    try {
      if (filename) {
        return handleFileResponse(response, filename, this.startTimeMs)
      } else {
        if (response.status === 204) {
          data = []
          raw = ""
        } else if (contentType.includes("application/json")) {
          data = await response.json()
          raw = JSON.stringify(data)
        } else if (
          contentType.includes("text/xml") ||
          contentType.includes("application/xml")
        ) {
          let xmlResponse = await handleXml(response)
          data = xmlResponse.data
          raw = xmlResponse.rawXml
        } else {
          data = await response.text()
          raw = data as string
        }
      }
    } catch (err) {
      throw `Failed to parse response body: ${err}`
    }

    let contentLength: string = response.headers.get("content-length")
    if (!contentLength && raw) {
      contentLength = Buffer.byteLength(raw, "utf8").toString()
    }
    const size = formatBytes(contentLength || "0")
    const time = `${Math.round(performance.now() - this.startTimeMs)}ms`
    headers = response.headers.raw()
    for (let [key, value] of Object.entries(headers)) {
      headers[key] = Array.isArray(value) ? value[0] : value
    }

    // Check if a pagination cursor exists in the response
    let nextCursor = null
    if (pagination?.responseParam) {
      nextCursor = get(data, pagination.responseParam)
    }

    return {
      data,
      info: {
        code: response.status,
        size,
        time,
      },
      extra: {
        raw,
        headers,
      },
      pagination: {
        cursor: nextCursor,
      },
    }
  }

  getUrl(
    path: string,
    queryString: string,
    pagination: PaginationConfig | null,
    paginationValues: PaginationValues | null
  ): string {
    // Add pagination params to query string if required
    if (pagination?.location === "query" && paginationValues) {
      const { pageParam, sizeParam } = pagination
      const params = new URLSearchParams()

      // Append page number or cursor param if configured
      if (pageParam && paginationValues.page != null) {
        params.append(pageParam, paginationValues.page as string)
      }

      // Append page size param if configured
      if (sizeParam && paginationValues.limit != null) {
        params.append(sizeParam, String(paginationValues.limit))
      }

      // Prepend query string with pagination params
      let paginationString = params.toString()
      if (paginationString) {
        queryString = `${paginationString}&${queryString}`
      }
    }

    if (queryString) {
      // make sure the query string is fully encoded
      queryString = "?" + qs.encode(qs.decode(queryString))
    }
    const main = `${path}${queryString}`

    let complete = main
    if (this.config.url && !main.startsWith("http")) {
      complete = !this.config.url ? main : `${this.config.url}/${main}`
    }
    if (!complete.startsWith("http")) {
      complete = `http://${complete}`
    }
    return complete
  }

  addBody(
    bodyType: string,
    body: string | any,
    input: any,
    pagination: PaginationConfig | null,
    paginationValues: PaginationValues | null
  ) {
    if (!input.headers) {
      input.headers = {}
    }
    if (bodyType === BodyType.NONE) {
      return input
    }
    let error,
      object: any = {},
      string = ""
    try {
      if (body) {
        string = typeof body !== "string" ? JSON.stringify(body) : body
        object = typeof body === "object" ? body : JSON.parse(body)
      }
    } catch (err) {
      error = err
    }

    // Util to add pagination values to a certain body type
    const addPaginationToBody = (insertFn: Function) => {
      if (pagination?.location === "body") {
        if (pagination?.pageParam && paginationValues?.page != null) {
          insertFn(pagination.pageParam, paginationValues.page)
        }
        if (pagination?.sizeParam && paginationValues?.limit != null) {
          insertFn(pagination.sizeParam, paginationValues.limit)
        }
      }
    }

    switch (bodyType) {
      case BodyType.TEXT:
        // content type defaults to plaintext
        input.body = string
        break
      case BodyType.ENCODED: {
        const params = new URLSearchParams()
        for (let [key, value] of Object.entries(object)) {
          params.append(key, value as string)
        }
        addPaginationToBody((key: string, value: any) => {
          params.append(key, value)
        })
        input.body = params
        break
      }
      case BodyType.FORM_DATA: {
        const form = new FormData()
        for (let [key, value] of Object.entries(object)) {
          form.append(key, value)
        }
        addPaginationToBody((key: string, value: any) => {
          form.append(key, value)
        })
        input.body = form
        break
      }
      case BodyType.XML:
        if (object != null && Object.keys(object).length) {
          string = new XmlBuilder().buildObject(object)
        }
        input.body = string
        input.headers["Content-Type"] = "application/xml"
        break
      case BodyType.JSON:
        // if JSON error, throw it
        if (error) {
          throw "Invalid JSON for request body"
        }
        addPaginationToBody((key: string, value: any) => {
          object[key] = value
        })
        input.body = JSON.stringify(object)
        input.headers["Content-Type"] = "application/json"
        break
    }
    return input
  }

  getAuthHeaders(authConfigId: string): { [key: string]: any } {
    let headers: any = {}

    if (this.config.authConfigs && authConfigId) {
      const authConfig = this.config.authConfigs.filter(
        c => c._id === authConfigId
      )[0]
      // check the config still exists before proceeding
      // if not - do nothing
      if (authConfig) {
        let config
        switch (authConfig.type) {
          case RestAuthType.BASIC:
            config = authConfig.config as RestBasicAuthConfig
            headers.Authorization = `Basic ${Buffer.from(
              `${config.username}:${config.password}`
            ).toString("base64")}`
            break
          case RestAuthType.BEARER:
            config = authConfig.config as RestBearerAuthConfig
            headers.Authorization = `Bearer ${config.token}`
            break
        }
      }
    }

    return headers
  }

  async _req(query: RestQuery) {
    const {
      path = "",
      queryString = "",
      headers = {},
      method = HttpMethod.GET,
      disabledHeaders,
      bodyType,
      requestBody,
      authConfigId,
      pagination,
      paginationValues,
    } = query
    const authHeaders = this.getAuthHeaders(authConfigId)

    this.headers = {
      ...this.config.defaultHeaders,
      ...headers,
      ...authHeaders,
    }

    if (disabledHeaders) {
      for (let headerKey of Object.keys(this.headers)) {
        if (disabledHeaders[headerKey]) {
          delete this.headers[headerKey]
        }
      }
    }

    let input: any = { method, headers: this.headers }
    input = this.addBody(
      bodyType,
      requestBody,
      input,
      pagination,
      paginationValues
    )

    if (this.config.rejectUnauthorized == false) {
      input.agent = new https.Agent({
        rejectUnauthorized: false,
      })
    }

    // Deprecated by rejectUnauthorized
    if (this.config.legacyHttpParser) {
      // https://github.com/nodejs/node/issues/43798
      input.extraHttpOptions = { insecureHTTPParser: true }
    }

    this.startTimeMs = performance.now()
    const url = this.getUrl(path, queryString, pagination, paginationValues)
    if (await blacklist.isBlacklisted(url)) {
      throw new Error("Cannot connect to URL.")
    }
    const response = await fetch(url, input)
    return await this.parseResponse(response, pagination)
  }

  async create(opts: RestQuery) {
    return this._req({ ...opts, method: HttpMethod.POST })
  }

  async read(opts: RestQuery) {
    return this._req({ ...opts, method: HttpMethod.GET })
  }

  async update(opts: RestQuery) {
    return this._req({ ...opts, method: HttpMethod.PUT })
  }

  async patch(opts: RestQuery) {
    return this._req({ ...opts, method: HttpMethod.PATCH })
  }

  async delete(opts: RestQuery) {
    return this._req({ ...opts, method: HttpMethod.DELETE })
  }
}

export default {
  schema: SCHEMA,
  integration: RestIntegration,
}
