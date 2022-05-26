import TestConfig from "../../../../tests/utilities/TestConfiguration"
import * as syncRows from "../syncRows"
import { quotas, QuotaUsageType, StaticQuotaName } from "@budibase/pro"
const { getProdAppID } = require("@budibase/backend-core/db")

describe("syncRows", () => {
  let config = new TestConfig(false)

  beforeEach(async () => {
    await config.init()
  })

  afterAll(config.end)

  it("runs successfully", async () => {
    return config.doInContext(null, async () => {
      // create the usage quota doc and mock usages
      await quotas.getQuotaUsage()
      await quotas.setUsage(300, StaticQuotaName.ROWS, QuotaUsageType.STATIC)

      let usageDoc = await quotas.getQuotaUsage()
      expect(usageDoc.usageQuota.rows).toEqual(300)

      // app 1
      const app1 = config.app
      await config.createTable()
      await config.createRow()
      // app 2
      const app2 = await config.createApp("second-app")
      await config.createTable()
      await config.createRow()
      await config.createRow()

      // migrate
      await syncRows.run()

      // assert the migration worked
      usageDoc = await quotas.getQuotaUsage()
      expect(usageDoc.usageQuota.rows).toEqual(3)
      expect(usageDoc.apps?.[getProdAppID(app1.appId)].usageQuota.rows).toEqual(
        1
      )
      expect(usageDoc.apps?.[getProdAppID(app2.appId)].usageQuota.rows).toEqual(
        2
      )
    })
  })
})
