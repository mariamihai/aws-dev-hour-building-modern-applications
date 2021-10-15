import * as cdk from '@aws-cdk/core';

import s3 = require('@aws-cdk/aws-s3');
import lambda = require('@aws-cdk/aws-lambda');
import event_sources = require('@aws-cdk/aws-lambda-event-sources');
import dynamodb = require('@aws-cdk/aws-dynamodb');
import iam = require('@aws-cdk/aws-iam');
import { Duration } from '@aws-cdk/core';

const imageBucketName = "cdk-rekn-bucket";

export class AwsDevHourBuildingModernApplicationsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {

    super(scope, id, props);

    // --------------------------------------------
    // Image Bucket
    // --------------------------------------------
    // Create bucket
    const imageBucket = new s3.Bucket(this, imageBucketName);
    // Give some output after the cdk has been deployed and the resource has been created
    // (CloudFormation output)
    new cdk.CfnOutput(this, 'imageBucket', {value: imageBucket.bucketName});


    // --------------------------------------------
    // DynamoDB table for storing image labels
    // --------------------------------------------
    const table = new dynamodb.Table(this, 'ImageLabels', {
      partitionKey: {
        name: 'image',
        type: dynamodb.AttributeType.STRING
      }
    })
    new cdk.CfnOutput(this, 'dbTable', {value: table.tableName});


    // --------------------------------------------
    // Lambda Function
    // --------------------------------------------
    const rekFn = new lambda.Function(this, 'rekognitionFunction', {
      code: lambda.Code.fromAsset('rekognitionlambda'), // zip archive for the code
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      memorySize: 1024,
      environment: {
        "TABLE": table.tableName,
        "BUCKET": imageBucket.bucketName
      },
    })

    rekFn.addEventSource(new event_sources.S3EventSource(imageBucket, { events: [ s3.EventType.OBJECT_CREATED ]}));
    imageBucket.grantRead(rekFn);
    table.grantWriteData(rekFn);

    rekFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels'],
      resources: ['*']
    }));
  }
}
