import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export interface PatchToyBackendStackProps extends StackProps {
  /**
   * JWT secret for token signing/verification
   * IMPORTANT: Set this in production via environment variable or secrets manager
   */
  jwtSecret?: string;

  /**
   * Enable API key requirement (optional layer of security)
   */
  requireApiKey?: boolean;
}

export class PatchToyBackendStack extends Stack {
  public readonly api: apigateway.RestApi;
  public readonly usersTable: dynamodb.Table;
  public readonly projectsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: PatchToyBackendStackProps) {
    super(scope, id, props);

    const { jwtSecret = 'dev-secret-change-in-production', requireApiKey = false } = props || {};

    // =====================
    // DynamoDB Tables
    // =====================

    // Users table
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'PatchToy-Users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Flexible for early stage
      removalPolicy: RemovalPolicy.RETAIN, // Keep data on stack deletion
      pointInTimeRecovery: true, // Enable backups
    });

    // GSI for querying by email
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for querying by username (for login & uniqueness check)
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'username-index',
      partitionKey: { name: 'username', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Projects table
    this.projectsTable = new dynamodb.Table(this, 'ProjectsTable', {
      tableName: 'PatchToy-Projects',
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // GSI for querying user's projects sorted by update time
    this.projectsTable.addGlobalSecondaryIndex({
      indexName: 'userId-updatedAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // =====================
    // Lambda Functions
    // =====================

    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        USERS_TABLE: this.usersTable.tableName,
        PROJECTS_TABLE: this.projectsTable.tableName,
        JWT_SECRET: jwtSecret,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk'],
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    };

    // Auth functions
    const registerFn = new NodejsFunction(this, 'RegisterFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/register.ts',
      handler: 'handler',
    });

    const loginFn = new NodejsFunction(this, 'LoginFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/login.ts',
      handler: 'handler',
    });

    const verifyFn = new NodejsFunction(this, 'VerifyFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/verify.ts',
      handler: 'handler',
    });

    // Project functions
    const listProjectsFn = new NodejsFunction(this, 'ListProjectsFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/list.ts',
      handler: 'handler',
    });

    const getProjectFn = new NodejsFunction(this, 'GetProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/get.ts',
      handler: 'handler',
    });

    const saveProjectFn = new NodejsFunction(this, 'SaveProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/save.ts',
      handler: 'handler',
    });

    const updateProjectFn = new NodejsFunction(this, 'UpdateProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/update.ts',
      handler: 'handler',
    });

    const deleteProjectFn = new NodejsFunction(this, 'DeleteProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/delete.ts',
      handler: 'handler',
    });

    const toggleVisibilityFn = new NodejsFunction(this, 'ToggleVisibilityFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/toggle-visibility.ts',
      handler: 'handler',
    });

    // Grant DynamoDB permissions
    this.usersTable.grantReadWriteData(registerFn);
    this.usersTable.grantReadData(loginFn);

    this.projectsTable.grantReadData(listProjectsFn);
    this.projectsTable.grantReadData(getProjectFn);
    this.projectsTable.grantWriteData(saveProjectFn);
    this.projectsTable.grantReadWriteData(updateProjectFn);
    this.projectsTable.grantReadWriteData(deleteProjectFn);
    this.projectsTable.grantReadWriteData(toggleVisibilityFn);

    // =====================
    // API Gateway
    // =====================

    this.api = new apigateway.RestApi(this, 'PatchToyApi', {
      restApiName: 'PatchToy API',
      description: 'Backend API for PatchToy',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // TODO: Restrict in production
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
        allowCredentials: true,
      },
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });

    // Optional: Add API key requirement
    let apiKey: apigateway.IApiKey | undefined;
    let usagePlan: apigateway.UsagePlan | undefined;

    if (requireApiKey) {
      const key = new apigateway.ApiKey(this, 'ApiKey', {
        apiKeyName: 'PatchToyApiKey',
      });
      apiKey = key;

      usagePlan = this.api.addUsagePlan('UsagePlan', {
        name: 'Standard',
        throttle: {
          rateLimit: 100,
          burstLimit: 200,
        },
        quota: {
          limit: 10000,
          period: apigateway.Period.DAY,
        },
      });

      usagePlan.addApiKey(key);
      usagePlan.addApiStage({ stage: this.api.deploymentStage });
    }

    // API routes
    const apiRoot = this.api.root.addResource('api');

    // Auth routes
    const auth = apiRoot.addResource('auth');
    auth.addResource('register').addMethod('POST', new apigateway.LambdaIntegration(registerFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('login').addMethod('POST', new apigateway.LambdaIntegration(loginFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('verify').addMethod('GET', new apigateway.LambdaIntegration(verifyFn), {
      apiKeyRequired: requireApiKey,
    });

    // Projects routes
    const projects = apiRoot.addResource('projects');
    projects.addMethod('GET', new apigateway.LambdaIntegration(listProjectsFn), {
      apiKeyRequired: requireApiKey,
    });
    projects.addMethod('POST', new apigateway.LambdaIntegration(saveProjectFn), {
      apiKeyRequired: requireApiKey,
    });

    const project = projects.addResource('{id}');
    project.addMethod('GET', new apigateway.LambdaIntegration(getProjectFn), {
      apiKeyRequired: requireApiKey,
    });
    project.addMethod('PUT', new apigateway.LambdaIntegration(updateProjectFn), {
      apiKeyRequired: requireApiKey,
    });
    project.addMethod('DELETE', new apigateway.LambdaIntegration(deleteProjectFn), {
      apiKeyRequired: requireApiKey,
    });

    const visibility = project.addResource('visibility');
    visibility.addMethod('PUT', new apigateway.LambdaIntegration(toggleVisibilityFn), {
      apiKeyRequired: requireApiKey,
    });

    // Output API URL
    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'PatchToy API Gateway URL',
    });

    if (apiKey) {
      new CfnOutput(this, 'ApiKeyId', {
        value: apiKey.keyId,
        description: 'API Key ID (retrieve value from console)',
      });
    }
  }
}
