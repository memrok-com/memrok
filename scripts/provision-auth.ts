#!/usr/bin/env bun

import { readFile, writeFile } from "fs/promises"
import { join } from "path"
import { $ } from "bun"

interface MachineKey {
  type: string
  keyId: string
  key: string
  userId: string
}

interface ZitadelConfig {
  apiUrl: string
  domain: string
  projectName: string
  applicationName: string
  redirectUris: string[]
}

class ZitadelProvisioner {
  private config: ZitadelConfig
  private machineKey?: MachineKey
  private accessToken?: string

  constructor(config: ZitadelConfig) {
    this.config = config
  }

  async loadServiceAccount(): Promise<void> {
    try {
      // Try to load machine key from Docker volume mount
      const machineKeyPath = "/machinekey/memrok-provisioner.json"
      const machineKeyContent = await readFile(machineKeyPath, "utf-8")
      this.machineKey = JSON.parse(machineKeyContent)
      // Service account loaded successfully
    } catch (error) {
      // Fallback to local development path
      try {
        const localPath = join(process.cwd(), "deployment", "zitadel", "machinekey", "memrok-provisioner.json")
        const machineKeyContent = await readFile(localPath, "utf-8")
        this.machineKey = JSON.parse(machineKeyContent)
        // Service account loaded from local path
      } catch (localError) {
        throw new Error("Failed to load machine key. Make sure Zitadel is running and the service account is created.")
      }
    }
  }

  async authenticate(): Promise<void> {
    if (!this.machineKey) {
      throw new Error("Machine key not loaded")
    }

    // Create JWT for authentication
    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: this.machineKey.keyId
    }

    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: this.machineKey.userId,
      sub: this.machineKey.userId,
      aud: this.config.apiUrl,
      iat: now,
      exp: now + 3600, // 1 hour
      scope: "openid profile email urn:zitadel:iam:org:project:id:zitadel:aud"
    }

    // For now, we'll use the PAT if available
    try {
      const patPath = "/pat/memrok-provisioner.pat"
      const pat = await readFile(patPath, "utf-8")
      this.accessToken = pat.trim()
      // Using PAT for authentication
      return
    } catch (error) {
      // Try local development path
      try {
        const localPatPath = join(process.cwd(), "deployment", "zitadel", "pat", "memrok-provisioner.pat")
        const pat = await readFile(localPatPath, "utf-8")
        this.accessToken = pat.trim()
        // Using PAT from local path
        return
      } catch (localError) {
        throw new Error("Failed to load PAT. Make sure Zitadel is running and the service account is created.")
      }
    }
  }

  async findProject(): Promise<string | null> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    const response = await fetch(`${this.config.apiUrl}/management/v1/projects/_search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queries: [
          {
            nameQuery: {
              name: this.config.projectName,
              method: "TEXT_QUERY_METHOD_EQUALS"
            }
          }
        ]
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to search for project: ${error}`)
    }

    const result = await response.json()
    if (result.result && result.result.length > 0) {
      const project = result.result[0]
      // Found existing project
      return project.id
    }

    return null
  }

  async createProject(): Promise<string> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    // Check if project already exists
    const existingProjectId = await this.findProject()
    if (existingProjectId) {
      return existingProjectId
    }

    const response = await fetch(`${this.config.apiUrl}/management/v1/projects`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: this.config.projectName,
        projectRoleAssertion: true,
        projectRoleCheck: true,
        hasProjectCheck: true,
        privateLabelingSetting: "PRIVATE_LABELING_SETTING_ALLOW_LOGIN_USER_RESOURCE_OWNER_POLICY"
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to create project: ${error}`)
    }

    const result = await response.json()
    // Project created successfully
    return result.id
  }

  async findApplication(projectId: string): Promise<any | null> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    const response = await fetch(`${this.config.apiUrl}/management/v1/projects/${projectId}/apps/_search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queries: [
          {
            nameQuery: {
              name: this.config.applicationName,
              method: "TEXT_QUERY_METHOD_EQUALS"
            }
          }
        ]
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to search for application: ${error}`)
    }

    const result = await response.json()
    if (result.result && result.result.length > 0) {
      const app = result.result[0]
      // Found existing application
      return app
    }

    return null
  }

  async createApplication(projectId: string): Promise<void> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    // Check if application already exists
    const existingApp = await this.findApplication(projectId)
    if (existingApp) {
      console.log(`Note: Using existing application. Delete from Zitadel console to generate new credentials.`)
      return
    }

    // Create OIDC Web Application
    const response = await fetch(`${this.config.apiUrl}/management/v1/projects/${projectId}/apps/oidc`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: this.config.applicationName,
        redirectUris: this.config.redirectUris,
        postLogoutRedirectUris: this.config.redirectUris.map(uri => uri.replace(/\/auth\/callback$/, "/")),
        responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
        grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
        appType: "OIDC_APP_TYPE_WEB",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",  // PKCE for Web Apps
        version: "OIDC_VERSION_1_0",
        clockSkew: "5s",
        devMode: process.env.NODE_ENV === "development",
        accessTokenType: "OIDC_ACCESS_TOKEN_TYPE_JWT",
        accessTokenRoleAssertion: true,
        idTokenRoleAssertion: true,
        idTokenUserInfoAssertion: true,
        additionalOrigins: []
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to create application: ${error}`)
    }

    const result = await response.json()
    console.log(`✓ Created application with Client ID: ${result.clientId}`)

    // Save credentials to a secure location
    const credentials = {
      clientId: result.clientId,
      issuer: `https://${this.config.domain}`,
      projectId: projectId,
      applicationId: result.appId,
      redirectUri: this.config.redirectUris[0],
      postLogoutRedirectUri: this.config.redirectUris[0].replace(/\/auth\/callback$/, "/")
    }

    // Update .env file with the new credentials
    await this.updateEnvFile({
      NUXT_OIDC_CLIENT_ID: credentials.clientId,
      NUXT_OIDC_ISSUER: credentials.issuer,
      NUXT_OIDC_REDIRECT_URI: credentials.redirectUri,
      NUXT_OIDC_POST_LOGOUT_REDIRECT_URI: credentials.postLogoutRedirectUri
    })
    
    console.log("\n✅ Updated .env file with OIDC configuration")
  }

  async updateEnvFile(variables: Record<string, string>): Promise<void> {
    const envPath = join(process.cwd(), '.env')
    
    // Read existing .env file
    let envContent = ''
    try {
      envContent = await readFile(envPath, 'utf-8')
    } catch (error) {
      throw new Error('.env file not found. Please create one from .env.example first.')
    }
    
    // Update or add each variable
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`^${key}=.*$`, 'm')
      if (regex.test(envContent)) {
        // Update existing variable
        envContent = envContent.replace(regex, `${key}="${value}"`)
      } else {
        // Add new variable at the end
        envContent += `\n${key}="${value}"`
      }
    }
    
    // Write back to file
    await writeFile(envPath, envContent)
  }

  async waitForZitadel(): Promise<void> {
    console.log("⏳ Waiting for Zitadel to be ready...")
    const maxRetries = 60
    const retryInterval = 2000 // 2 seconds

    // First wait for basic health check
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${this.config.apiUrl}/debug/ready`)
        if (response.ok) {
          break
        }
      } catch (error) {
        // Expected to fail while starting up
      }

      if (i === maxRetries - 1) {
        throw new Error("Timeout waiting for Zitadel health check")
      }

      process.stdout.write(".")
      await new Promise(resolve => setTimeout(resolve, retryInterval))
    }

    console.log("\n⏳ Waiting for API to be fully ready...")

    // Now wait for the actual API to be available by testing with service account
    await this.loadServiceAccount()
    await this.authenticate()

    for (let i = 0; i < maxRetries; i++) {
      try {
        // Test the API by trying to list projects (lightweight call)
        const response = await fetch(`${this.config.apiUrl}/management/v1/projects/_search`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            queries: [],
            limit: 1
          }),
        })

        if (response.ok) {
          console.log(" Ready!")
          return
        }
      } catch (error) {
        // Expected to fail while API is starting up
      }

      process.stdout.write(".")
      await new Promise(resolve => setTimeout(resolve, retryInterval))
    }

    throw new Error("Timeout waiting for Zitadel API to be ready")
  }

  async getAdminUser(): Promise<string> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    // Search for the admin user by email
    const adminEmail = process.env.ZITADEL_ADMIN_EMAIL || "admin@memrok.com"

    const response = await fetch(`${this.config.apiUrl}/management/v1/users/_search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queries: [
          {
            emailQuery: {
              emailAddress: adminEmail,
              method: "TEXT_QUERY_METHOD_EQUALS"
            }
          }
        ]
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to find admin user: ${error}`)
    }

    const result = await response.json()
    if (result.result && result.result.length > 0) {
      const adminUser = result.result[0]
      // Found admin user
      return adminUser.id
    }

    throw new Error(`Admin user with email ${adminEmail} not found`)
  }

  async createUserGrant(projectId: string, userId: string): Promise<void> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    // Check if user grant already exists
    const searchResponse = await fetch(`${this.config.apiUrl}/management/v1/users/grants/_search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queries: [
          {
            projectIdQuery: {
              projectId: projectId
            }
          },
          {
            userIdQuery: {
              userId: userId
            }
          }
        ]
      }),
    })

    if (searchResponse.ok) {
      const searchResult = await searchResponse.json()
      if (searchResult.result && searchResult.result.length > 0) {
        // Admin user already authorized
        return
      }
    }

    // Create user grant (authorization) for the admin user
    const response = await fetch(`${this.config.apiUrl}/management/v1/users/${userId}/grants`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: projectId,
        roleKeys: [] // Empty array means grant access without specific roles
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to create user grant: ${error}`)
    }

    // Created user authorization
  }

  async provision(): Promise<void> {
    console.log("🚀 Provisioning Zitadel...")

    try {
      await this.waitForZitadel()
      console.log("")

      // Get admin user ID
      const adminUserId = await this.getAdminUser()

      // Create project
      const projectId = await this.createProject()

      // Create user grant (authorization) for admin user
      await this.createUserGrant(projectId, adminUserId)

      // Create application
      await this.createApplication(projectId)

      console.log("\n✅ Provisioning completed successfully!")

    } catch (error) {
      console.error("\n❌ Provisioning failed:", error)
      process.exit(1)
    }
  }
}

// Main execution
async function main() {
  const isDev = process.env.NODE_ENV === "development" || !process.env.NODE_ENV

  const config: ZitadelConfig = {
    apiUrl: isDev ? "https://auth.dev.memrok.com" : "https://auth.memrok.com",
    domain: isDev ? "auth.dev.memrok.com" : "auth.memrok.com",
    projectName: "memrok",
    applicationName: "memrok Web App",
    redirectUris: isDev
      ? ["https://app.dev.memrok.com/auth/callback"]
      : ["https://app.memrok.com/auth/callback"]
  }

  const provisioner = new ZitadelProvisioner(config)
  await provisioner.provision()
}

main().catch(console.error)