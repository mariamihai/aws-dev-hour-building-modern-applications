import * as cdk from '@aws-cdk/core';
import {CfnOutput, Duration} from '@aws-cdk/core';
import {AuthorizationType, PassthroughBehavior} from "@aws-cdk/aws-apigateway";
import s3 = require('@aws-cdk/aws-s3');
import { HttpMethods } from '@aws-cdk/aws-s3';
import s3deploy = require('@aws-cdk/aws-s3-deployment');
import lambda = require('@aws-cdk/aws-lambda');
import event_sources = require('@aws-cdk/aws-lambda-event-sources');
import dynamodb = require('@aws-cdk/aws-dynamodb');
import iam = require('@aws-cdk/aws-iam');
import apigw = require('@aws-cdk/aws-apigateway');
import cognito = require('@aws-cdk/aws-cognito');

const imageBucketName = "cdk-rekn-bucket";
const resizeImageBucketName = imageBucketName + "-resized";
const websiteBucketName = "cdk-rekn-publicbucket";

export class AwsDevHourBuildingModernApplicationsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {

    super(scope, id, props);

    // --------------------------------------------
    // Image Bucket
    // --------------------------------------------
    // Create bucket
    const imageBucket = new s3.Bucket(this, imageBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });
    // Give some output after the cdk has been deployed and the resource has been created
    // (CloudFormation output)
    new CfnOutput(this, 'imageBucket', {value: imageBucket.bucketName});
    const imageBucketArn = imageBucket.bucketArn;
    imageBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000
    });


    // --------------------------------------------
    // Thumbnail Bucket
    // --------------------------------------------
    const resizeImageBucket = new s3.Bucket(this, resizeImageBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });
    new CfnOutput(this, 'resizeImageBucket', {value: resizeImageBucket.bucketName});
    const resizedBucketArn = resizeImageBucket.bucketArn;
    resizeImageBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000
    });


    // --------------------------------------------
    // Website Bucket
    // --------------------------------------------
    const webBucket = new s3.Bucket(this, websiteBucketName, {
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      removalPolicy: cdk.RemovalPolicy.DESTROY
      // publicReadAccess: true,
    });

    // Add policy instead of exposing the bucket with publicReadAccess to everyone
    webBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [webBucket.arnForObjects('*')],
      principals: [new iam.AnyPrincipal()],
      // TODO: Change the IP address
      conditions: {
        'IpAddress': {
          'aws:SourceIp': [
            '*.*.*.*/*'
          ]
        }
      }
    }));
    new cdk.CfnOutput(this, 'bucketURL', { value: webBucket.bucketWebsiteDomainName });


    // --------------------------------------------
    // Deploy the site to S3 Bucket
    // --------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      // The front end project is in this folder
      // Create a zip archive of this folder and upload it in the S3 bucket
      sources: [ s3deploy.Source.asset('./public') ],
      destinationBucket: webBucket
    });

    // --------------------------------------------
    // DynamoDB table for storing image labels
    // --------------------------------------------
    const table = new dynamodb.Table(this, 'ImageLabels', {
      partitionKey: {
        name: 'image',
        type: dynamodb.AttributeType.STRING
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })
    new CfnOutput(this, 'dbTable', {value: table.tableName});


    // --------------------------------------------
    // Lambda Layer
    // --------------------------------------------
    const pilLayer = new lambda.LayerVersion(this, 'pil', {
      code: lambda.Code.fromAsset('reklayer'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
      license: 'Apache-2.0',
      description: 'A layer to enable the PIL library in the Rekognition Lambda'
    });


    // --------------------------------------------
    // Lambda Function for Rekognition
    // --------------------------------------------
    const rekFn = new lambda.Function(this, 'rekognitionFunction', {
      code: lambda.Code.fromAsset('rekognitionlambda'), // zip archive for the code
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      memorySize: 1024,
      layers: [pilLayer],
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName,
        "RESIZEDBUCKET": resizeImageBucket.bucketName
      }
    })

    rekFn.addEventSource(new event_sources.S3EventSource(imageBucket, { events: [ s3.EventType.OBJECT_CREATED ]}));
    imageBucket.grantRead(rekFn);
    resizeImageBucket.grantPut(rekFn);
    table.grantWriteData(rekFn);

    rekFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels'],
      resources: ['*']
    }));


    // --------------------------------------------
    // Service Lambda Function
    // --------------------------------------------
    const serviceFn = new lambda.Function(this, 'serviceFunction', {
      code: lambda.Code.fromAsset('servicelambda'),
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName,
        "RESIZEDBUCKET": resizeImageBucket.bucketName
      },
    });

    imageBucket.grantWrite(serviceFn);
    resizeImageBucket.grantWrite(serviceFn);
    table.grantReadWriteData(serviceFn);

    // --------------------------------------------
    // API Gateway
    // --------------------------------------------
    const api = new apigw.LambdaRestApi(this, 'imageAPI', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS
      },
      handler: serviceFn,
      proxy: false
      // Can add deployOptions as stageName here as well
    });
    new CfnOutput(this, 'apiUrl', {value: api.url})

    // --------------------------------------------
    // API Gateway with AWS Lambda integration
    // --------------------------------------------
    const lambdaIntegration = new apigw.LambdaIntegration(serviceFn, {
      proxy: false,
      requestParameters: {
        'integration.request.querystring.action': 'method.request.querystring.action',
        'integration.request.querystring.key': 'method.request.querystring.key'
      },
      requestTemplates: {
        'application/json':
            JSON.stringify({
              action: "$util.escapeJavaScript($input.params('action'))",
              key: "$util.escapeJavaScript($input.params('key'))"
            })
      },
      passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES,
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            // We can map response parameters
            // - Destination parameters (the key) are the response parameters (used in mappings)
            // - Source parameters (the value) are the integration response parameters or expressions
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        },
        {
          // For errors, we check if the error message is not empty, get the error data
          selectionPattern: "(\n|.)+",
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        }
      ],
    });

    // --------------------------------------------
    // Cognito User Pool Authentication
    // --------------------------------------------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true, // Allow Sign Up
      autoVerify: { email: true }, // Verify email address by sending a verification code
      signInAliases: { username: true, email: true } // Set email as an alias
    });

    const auth = new apigw.CfnAuthorizer(this, 'APIGatewayAuthorizer', {
      name: 'customer-authorizer',
      identitySource: 'method.request.header.Authorization',
      providerArns: [userPool.userPoolArn],
      restApiId: api.restApiId,
      type: AuthorizationType.COGNITO,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      generateSecret: false // Don't need to generate secret for web app running on browsers
    });

    const identityPool = new cognito.CfnIdentityPool(this, 'ImageRekognitionIdentityPool', {
      allowUnauthenticatedIdentities: false, // Don't allow unauthenticated users
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName
        }
      ]
    });

    const authenticatedRole = new iam.Role(this, "ImageRekognitionAuthenticatedRole", {
      assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": identityPool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "authenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
      ),
    });

    // IAM policy granting users permission to upload, download and delete their own pictures
    authenticatedRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "s3:GetObject",
            "s3:PutObject"
          ],
          effect: iam.Effect.ALLOW,
          resources: [
            imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
            imageBucketArn + "/private/${cognito-identity.amazonaws.com:sub}",
            resizedBucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*",
            resizedBucketArn + "/private/${cognito-identity.amazonaws.com:sub}"
          ],
        })
    );

    // IAM policy granting users permission to list their pictures
    authenticatedRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          effect: iam.Effect.ALLOW,
          resources: [
            imageBucketArn,
            resizedBucketArn
          ],
          conditions: {"StringLike": {"s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"]}}
        })
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, "IdentityPoolRoleAttachment", {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    // Export values of Cognito
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "AppClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });

    // --------------------------------------------
    // API Gateway /images resources
    // --------------------------------------------
    const imageAPI = api.root.addResource('images');

    // GET /images
    imageAPI.addMethod('GET', lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        'method.request.querystring.action': true,
        'method.request.querystring.key': true
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });

    // DELETE /images
    imageAPI.addMethod('DELETE', lambdaIntegration, {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: { authorizerId: auth.ref },
      requestParameters: {
        'method.request.querystring.action': true,
        'method.request.querystring.key': true
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });
  }
}