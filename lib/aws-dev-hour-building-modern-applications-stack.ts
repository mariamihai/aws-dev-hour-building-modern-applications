import * as cdk from '@aws-cdk/core';

import s3 = require('@aws-cdk/aws-s3');
import lambda = require('@aws-cdk/aws-lambda');
import event_sources = require('@aws-cdk/aws-lambda-event-sources');
import dynamodb = require('@aws-cdk/aws-dynamodb');
import iam = require('@aws-cdk/aws-iam');
import { Duration } from '@aws-cdk/core';

const imageBucketName = "cdk-rekn-bucket";
const resizeImageBucketName = imageBucketName + "-resized";

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
    new cdk.CfnOutput(this, 'imageBucket', {value: imageBucket.bucketName});


    // --------------------------------------------
    // Thumbnail Bucket
    // --------------------------------------------
    const resizeImageBucket = new s3.Bucket(this, resizeImageBucketName, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });
    new cdk.CfnOutput(this, 'resizeImageBucket', {value: resizeImageBucket.bucketName});


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
    new cdk.CfnOutput(this, 'dbTable', {value: table.tableName});


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
  }
}
